const { config, persist, cinemeta } = require('internal')
const { addonBuilder, getRouter } = require('stremio-addon-sdk')
const base64 = require('base-64')
const async = require('async')
const needle = require('needle')

function retrieveRouter() {

	return new Promise((resolver, rejecter) => {

		const headers = {
			'accept': 'application/json',
			'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
			'Origin': 'http://app.emby.media',
			'Referer': 'http://app.emby.media/',
			'Sec-Fetch-Mode': 'cors',
			'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/76.0.3809.132 Safari/537.36',
			'X-Application': 'Emby Web/4.2.0.55'
		}

		let accessData = {}

		let servers = []

		const mapFromImdb = {}

		if (config.user && config.pass) {
			needle.post('https://connect.emby.media/service/user/authenticate', 'nameOrEmail=' + config.user + '&rawpw=' + config.pass, { headers }, (err, resp, body) => {
				try {
					body = JSON.parse(body)
				} catch(e) {}

				if (body['AccessToken']) {
					accessData = body

					headers['X-Connect-UserToken'] = body['AccessToken']

					console.log('emby client: credentials correct, user logged in')

					needle.get('https://connect.emby.media/service/servers?userId=' + accessData['User']['Id'], { headers }, (err, resp, body) => {
						try {
							body = JSON.parse(body)
						} catch(e) {}

						if (body && Array.isArray(body) && body.length) {

							console.log('emby client: ' + body.length + ' servers added from user ' + accessData['User']['Name'])

							const serverQueue = async.queue((serverData, callback) => {

								// connect to server and get all needed manifest data

								let serverUrl

								if (serverData['Url']) {
									console.log('emby client: ' + serverData['Name'] + ' -> remote url: ' + serverData['Url'])
									serverUrl = serverData['Url']
								} else if (serverData['LocalAddress']) {
									console.log('emby client: ' + serverData['Name'] + ' -> local address: ' + serverData['LocalAddress'])
									serverUrl = serverData['LocalAddress']
								}

								if (!serverUrl) {
									console.log('emby client: could not get remote url or local address for server ' + serverData['Name'] + ', aborting connection attempt')
									callback()
									return
								}

								servers.push({
									url: serverUrl,
									key: serverData['AccessKey'],
									name: serverData['Name'],
									headers: {
										'accept': 'application/json',
										'Origin': 'http://app.emby.media',
										'Referer': 'http://app.emby.media/',
										'Sec-Fetch-Mode': 'cors',
										'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/76.0.3809.132 Safari/537.36',
									}
								})

								const serverIdx = servers.length -1

								servers[serverIdx].headers['X-Emby-Authorization'] = 'MediaBrowser Client="Emby Web", Device="Chrome", DeviceId="' + base64.encode(servers[serverIdx].headers['User-Agent'] + '|' + Date.now()) + '", Version="4.2.0.55"'

								servers[serverIdx].headers['X-MediaBrowser-Token'] = servers[serverIdx].key

								needle.get(servers[serverIdx].url + '/emby/Connect/Exchange?format=json&ConnectUserId=' + accessData['User']['Id'], { headers: servers[serverIdx].headers }, (err, resp, body) => {
									try {
										body = JSON.parse(body)
									} catch(e) {}

//									console.log(body)

									if (body && body['LocalUserId'] && body['AccessToken']) {
										servers[serverIdx].user = {
											id: body['LocalUserId'],
											token: body['AccessToken']
										}
										console.log('emby client: authenticated user ' + accessData['User']['Name'] + ' to server ' + servers[serverIdx].name)

										delete servers[serverIdx].headers['X-Emby-Authorization'] // no longer needed

										needle.get(servers[serverIdx].url + '/Users/' + servers[serverIdx].user.id + '/Views', { headers: servers[serverIdx].headers }, (err, resp, body) => {
											try {
												body = JSON.parse(body)
											} catch(e) {}

//											console.log(body)

											if (((body || {})['Items'] || []).length) {

												servers[serverIdx].catalogs = []

												// keep only movies and tv
												body['Items'].forEach(el => {
													if (el['CollectionType'] == 'movies') {
														servers[serverIdx].catalogs.push({
															name: el['Name'] + ' - ' + servers[serverIdx].name,
															id: servers[serverIdx].key + '|' + el['Id'],
															type: 'movie',
															extra: [{ name: 'skip' }]
														})
													} else if (el['CollectionType'] == 'tvshows') {
														servers[serverIdx].catalogs.push({
															name: el['Name'] + ' - ' + servers[serverIdx].name,
															id: servers[serverIdx].key + '|' + el['Id'],
															type: 'series',
															extra: [{ name: 'skip' }]
														})
													}
												})

												servers[serverIdx].catalogs.push({
													name: 'Movies' + ' - ' + servers[serverIdx].name,
													id: 'emby:search:movie:' + servers[serverIdx].key,
													type: 'movie',
													extra: [{ name: 'search', isRequired: true }]
												})

												servers[serverIdx].catalogs.push({
													name: 'Series' + ' - ' + servers[serverIdx].name,
													id: 'emby:search:series:' + servers[serverIdx].key,
													type: 'series',
													extra: [{ name: 'search', isRequired: true }]
												})

												servers[serverIdx].genreMaps = {}

												const q = async.queue((task,cb) => {
													const channelId = task.id.split('|')[1]
													const type = task.type.charAt(0).toUpperCase() + task.type.slice(1)
													needle.get(servers[serverIdx].url + '/Genres?SortBy=SortName&SortOrder=Ascending&IncludeItemTypes='+type+'&Recursive=true&Fields=BasicSyncInfo%2CMediaSourceCount%2CSortName%2CPrimaryImageAspectRatio&ImageTypeLimit=1&EnableImageTypes=Primary%2CBackdrop%2CThumb&StartIndex=0&ParentId=' + channelId + '&userId=' + servers[serverIdx].user.id, { headers: servers[serverIdx].headers }, (err, resp, body) => {
														try {
															body = JSON.parse(body)
														} catch(e) {}
														if (((body || {})['Items'] || []).length) {
															let idx
															servers[serverIdx].catalogs.forEach((el, ij) => {
																if (el.id == task.id)
																	idx = ij
															})
															if (!idx && idx !== 0) {
																cb()
															} else {
																servers[serverIdx].genreMaps[channelId] = JSON.parse(JSON.stringify(body['Items']))
																servers[serverIdx].catalogs[idx].genres = body['Items'].map(el => { return el['Name'] })
																servers[serverIdx].catalogs[idx].extra = [ { name: 'genre' }, { name: 'skip' } ]
																cb()
															}
														} else {
															cb()
														}
													})
												}, 1)

												q.drain = () => {
													callback()
												}

												servers[serverIdx].catalogs.forEach(el => {
													q.push(el)
												})

//												console.log(servers[serverIdx].catalogs)

											} else {
												console.log('emby client: server ' + servers[serverIdx].name + ' has no catalogs')
												callback()
											}

										})
									} else {
										console.log('emby client: could not authenticate user ' + accessData['User']['Name'] + ' to server ' + servers[serverIdx].name)
										callback()
									}
								})
							}, 1)

							serverQueue.drain = () => {
								const manifest = {
									id: 'com.stremio.embyclient',
									name: 'Emby Client',
									description: 'Emby client to view your Emby Connect media servers in Stremio.',
									version: '0.0.1',
									catalogs: [],
									background: '',
									logo: 'https://emby.media/community/public/style_images/master/meta_image1.png',
									resources: ['catalog', 'meta', 'stream'],
									types: ['movie', 'series'],
									idPrefixes: ['emby:', 'tt']
								}
								servers.forEach(server => {
									manifest.catalogs = manifest.catalogs.concat(server.catalogs)
								})

								manifest.catalogs = manifest.catalogs.filter(el => !!el)

								const builder = new addonBuilder(manifest)

								builder.defineCatalogHandler(args => {
									return new Promise((resolve, reject) => {
										let serverId
										let channelId

										if (args.id.startsWith('emby:search:')) {
											const parts = args.id.split(':')
											serverId = parts[parts.length -1]
										} else {
											const parts = args.id.split('|')
											serverId = parts[0]
											channelId = parts[1]
										}

										let server 
										servers.some(el => {
											if (el.key == serverId) {
												server = el
												return true
											}
										})
										if (!server) {
											reject('emby client: could not find server for request: ' + args.id + ' / with genre: ' + args.extra.genre)
											return
										}

										function getCatalog(url) {
											needle.get(url, { headers: server.headers }, (err, resp, body) => {
												try {
													body = JSON.parse(body)
												} catch(e) {}

												if (((body || {})['Items'] || []).length) {
													resolve({
														metas: body['Items'].map(el => {
															const meta = {
																type: args.type,
																name: el['Name'],
																id: 'emby:' + serverId + '|' + el['Id'],
															}
															if ((el['ImageTags'] || {})['Primary'])
																meta.poster = server.url + '/Items/' + el['Id'] + '/Images/Primary?maxHeight=482&maxWidth=322&tag=' + el['ImageTags']['Primary'] + '&quality=90'

															return meta
														})
													})
												} else
													reject('emby client: could not get catalog items for request: ' + args.id + ' / with genre: ' + args.extra.genre)

											})
										}

										const type = args.type.charAt(0).toUpperCase() + args.type.slice(1)

										if (!args.extra.genre && !args.extra.search) {
											const url = server.url + '/emby/Users/' + server.user.id + '/Items?SortBy=DateCreated%2CSortName&SortOrder=Descending&IncludeItemTypes=' + type + '&Recursive=true&Fields=BasicSyncInfo%2CMediaSourceCount%2CSortName%2CPrimaryImageAspectRatio&ImageTypeLimit=1&EnableImageTypes=Primary%2CBackdrop%2CThumb&StartIndex=' + (args.extra.skip || 0) + '&Limit=100&ParentId=' + channelId
											getCatalog(url)
										} else if (args.extra.genre) {
											let genreId
											const gmap = server.genreMaps[channelId] || []

											gmap.some(el => {
												if (el['Name'] == args.extra.genre) {
													genreId = el['Id']
													return true
												}
											})
											if (!genreId) {
												reject('emby client: could not get genre id for request: ' + args.id + ' / with genre: ' + args.extra.genre)
												return
											}
											const url = server.url + '/Users/' + server.user.id + '/Items?SortBy=ProductionYear%2CPremiereDate%2CSortName&SortOrder=Descending&IncludeItemTypes=' + type + '&Fields=BasicSyncInfo%2CSortName%2CPrimaryImageAspectRatio%2CProductionYear%2CStatus%2CEndDate&ImageTypeLimit=1&EnableImageTypes=Primary%2CBackdrop%2CThumb&StartIndex=' + (args.extra.skip || 0) + '&ParentId=' + channelId + '&GenreIds=' + genreId + '&Recursive=true'
											getCatalog(url)
										} else if (args.extra.search) {
											const url = server.url + '/emby/Users/' + server.user.id + '/Items?searchTerm=' + encodeURIComponent(args.extra.search) + '&IncludePeople=false&IncludeMedia=true&IncludeGenres=false&IncludeStudios=false&IncludeArtists=false&IncludeItemTypes=' + type + '&Limit=16&Fields=PrimaryImageAspectRatio%2CCanDelete%2CBasicSyncInfo%2CProductionYear&Recursive=true&EnableTotalRecordCount=false&ImageTypeLimit=1'
											getCatalog(url)
										} else {
											reject('emby client: unknown catalog request')
										}
									})
								})

								builder.defineMetaHandler(args => {
									return new Promise((resolve, reject) => {
										const parts = args.id.replace('emby:', '').split('|')
										const serverId = parts[0]
										const itemId = parts[1]

										let server 
										servers.some(el => {
											if (el.key == serverId) {
												server = el
												return true
											}
										})

										if (!server) {
											reject('emby client: could not find server for meta request: ' + args.id + ' / of type: ' + args.type)
											return
										}

										const url = server.url + '/Users/' + server.user.id + '/Items/' + itemId

										needle.get(url, { headers: server.headers }, (err, resp, body) => {

												try {
													body = JSON.parse(body)
												} catch(e) {}

												if ((body || {})['Id']) {

													let actors = []
													if ((body['People'] || []).length) {
														actors = body['People'].filter(el => {
															return el['Type'] == 'Actor'
														}).map(el => {
															return el['Name']
														}).slice(0,5)
													}

													let poster
													if ((body['ImageTags'] || {})['Primary'])
														poster = server.url + '/Items/' + body['Id'] + '/Images/Primary?maxHeight=482&maxWidth=322&tag=' + body['ImageTags']['Primary'] + '&quality=90'

													let background
													if ((body['BackdropImageTags'] || []).length)
														background = server.url + '/Items/' + body['Id'] + '/Images/Backdrop/0?tag=' + body['BackdropImageTags'][0] + '&maxWidth=2200&quality=70'

													const meta = {
														id: args.id,
														type: args.type,
														name: body['Name'],
														genres: body['Genres'],
														description: body['Overview'],
														cast: actors,
														releaseInfo: body['ProductionYear'] || undefined,
														poster,
														background
													}

													if ((body['ProviderIds'] || {})['Imdb']) {
														mapFromImdb[body['ProviderIds']['Imdb']] = itemId
													}

													if (args.type == 'movie')
														resolve({ meta })
													else {
														// get seasons and episodes
														// easier to get from cinemeta
														if ((body['ProviderIds'] || {})['Imdb']) {
															cinemeta.get({ imdb: body['ProviderIds']['Imdb'], type: 'series' })
															.then(resp => {
															  if (resp.videos)
															  	meta.videos = resp.videos.map(el => {
															  		el.id = 'emby:' + serverId + '|' + el.id
															  		return el
															  	})
															  resolve({ meta })
															}).catch(err => {
															  resolve({ meta })
															})
														} else {

															// get season / episodes from emby api

															const seasonUrl = server.url + '/Shows/' + body['Id'] + '/Seasons?userId=' + server.user.id + '&Fields=PrimaryImageAspectRatio%2CBasicSyncInfo%2CCanDelete%2CProductionYear%2CPremiereDate&EnableTotalRecordCount=false'
															needle.get(seasonUrl, { headers: server.headers }, (err, resp, body) => {

																try {
																	body = JSON.parse(body)
																} catch(e) {}

																if (((body || {})['Items'] || []).length) {

																	let videos = []

																	let dummyTime = new Date(new Date().setFullYear(new Date().getFullYear() - 1)).getTime()

																	const days1 = 86400000

																	const seasonQ = async.queue((task, cb) => {

																		const szIdx = task['IndexNumber'] || -1

																		if (szIdx == -1)
																			cb()
																		else {
																			const episodeUrl = server.url + '/Shows/' + itemId + '/Episodes?seasonId=' + task['Id'] + '&userId=' + server.user.id + '&Fields=PrimaryImageAspectRatio%2CBasicSyncInfo%2CCanDelete%2CProductionYear%2CPremiereDate%2COverview&EnableTotalRecordCount=false'
																			needle.get(episodeUrl, { headers: server.headers }, (err, resp, body) => {

																				try {
																					body = JSON.parse(body)
																				} catch(e) {}

																				if (((body || {})['Items'] || []).length) {
																					let ep

																					const results = body['Items'].map(el => {
																						dummyTime += days1
																						return {
																							id: 'emby:' + serverId + '|' + el['Id'] + ':' + szIdx + ':' + el['IndexNumber'],
																							season: szIdx,
																							episode: el['IndexNumber'],
																							number: el['IndexNumber'],
																							name: el['Name'],
																							released: new Date(dummyTime).toISOString(),
																							firstAired: new Date(dummyTime).toISOString()
																						}
																					})

																					if ((results || []).length)
																						videos = videos.concat(results)

																					cb()
																				} else
																					cb()
																			})

																		} 

																	}, 1)

																	seasonQ.drain = () => {
																		meta.videos = videos
																		resolve({ meta })
																	}

																	body['Items'].forEach(el => {
																		seasonQ.push(el)
																	})
																} else {
																	reject('emby client: could not get seasons data from server for request: ' + args.id + ' / of type: ' + args.type)
																}
															})

//															resolve({ meta })
														}
													}

												} else {
													reject('emby client: could not get meta from server for request: ' + args.id + ' / of type: ' + args.type)
												}

										})

//										const url = server.url + '/Items/' + item.id + '/PlaybackInfo?UserId=' + server.user.id + '&StartTimeTicks=0&IsPlayback=false&AutoOpenLiveStream=false&MaxStreamingBitrate=1500000'

									})
								  // ..
								})

								builder.defineStreamHandler(args => {
									return new Promise((resolve, reject) => {
										const parts = args.id.replace('emby:', '').split('|')
										const serverId = parts[0]
										let itemId = parts[1]

										let season
										let episode

										if (itemId.includes(':')) {
											season = itemId.split(':')[1]
											episode = itemId.split(':')[2]
											itemId = itemId.split(':')[0]
										}

										let server 
										servers.some(el => {
											if (el.key == serverId) {
												server = el
												return true
											}
										})

										if (!server) {
											reject('emby client: could not find server for stream request: ' + args.id + ' / of type: ' + args.type)
											return
										}

										function getTranscodeStream(url, itemId) {

											const payload = require('./chromeProfile')

											needle.post(url, payload, { headers: server.headers, json: true }, (err, resp, body) => {

												try {
													body = JSON.parse(body)
												} catch(e) {}

//												console.log(body['MediaSources'])

												if (((body || {})['MediaSources'] || []).length) {


													if (body['MediaSources'][0]['TranscodingUrl']) {

														const sourceWeb = body['MediaSources'][0]['TranscodingUrl']

														const streams = [
															{
																title: 'Web Stream, Chrome Browser',
																url: server.url + sourceWeb
															}
														]

														streams.push({
															title: 'Direct URL',
															url: server.url + '/emby/Videos/' + itemId + '/stream?static=true&MediaSourceId=' + body['MediaSources'][0]['Id'] + '&api_key=' + server.user.token
														})

														resolve({ streams })
													} else {
														reject('emby client: could not fetch the streams for stream request: ' + args.id + ' / of type: ' + args.type)
													}

												} else {
													reject('emby client: could not find any streams for stream request: ' + args.id + ' / of type: ' + args.type)
												}
											})
										}

										if (itemId.startsWith('tt') && parseInt(itemId.replace('tt','')) == itemId.replace('tt','')) {
											if (!mapFromImdb[itemId]) {
												reject('emby client: could not find imdb id for request: ' + args.id + ' / of type: ' + args.type)
												return
											} else {
												itemId = mapFromImdb[itemId]
											}
										} else if (args.type == 'series') {
											// presume id is of episode already
											const url = server.url + '/Items/' + itemId + '/PlaybackInfo?UserId=' + server.user.id + '&StartTimeTicks=0&IsPlayback=false&AutoOpenLiveStream=false&MaxStreamingBitrate=1500000'
											getTranscodeStream(url, itemId)
											return
										}

										if (args.type == 'movie') {
											const url = server.url + '/Items/' + itemId + '/PlaybackInfo?UserId=' + server.user.id + '&StartTimeTicks=0&IsPlayback=false&AutoOpenLiveStream=false&MaxStreamingBitrate=1500000'
											getTranscodeStream(url, itemId)
										} else if (args.type == 'series') {
											const seasonUrl = server.url + '/Shows/' + itemId + '/Seasons?userId=' + server.user.id + '&Fields=PrimaryImageAspectRatio%2CBasicSyncInfo%2CCanDelete%2CProductionYear%2CPremiereDate&EnableTotalRecordCount=false'
											needle.get(seasonUrl, { headers: server.headers }, (err, resp, body) => {

												try {
													body = JSON.parse(body)
												} catch(e) {}

												if (((body || {})['Items'] || []).length) {
													let sz

													body['Items'].some(el => {
														if (el['IndexNumber'] == season) {
															sz = el
															return true
														}
													})

													if (!sz) {
														reject('emby client: cannot find season ' + season + ' for request: ' + args.id + ' / of type: ' + args.type)
													} else {
														const episodeUrl = server.url + '/Shows/' + itemId + '/Episodes?seasonId=' + sz['Id'] + '&userId=' + server.user.id + '&Fields=PrimaryImageAspectRatio%2CBasicSyncInfo%2CCanDelete%2CProductionYear%2CPremiereDate%2COverview&EnableTotalRecordCount=false'
														needle.get(episodeUrl, { headers: server.headers }, (err, resp, body) => {

															try {
																body = JSON.parse(body)
															} catch(e) {}

															if (((body || {})['Items'] || []).length) {
																let ep

																body['Items'].some(el => {
																	if (el['IndexNumber'] == episode) {
																		ep = el
																		return true
																	}
																})

																if (!ep) {
																	reject('emby client: cannot find episode ' + season + ':' + episode + ' for request: ' + args.id + ' / of type: ' + args.type)
																} else {
																	const url = server.url + '/Items/' + ep['Id'] + '/PlaybackInfo?UserId=' + server.user.id + '&StartTimeTicks=0&IsPlayback=false&AutoOpenLiveStream=false&MaxStreamingBitrate=1500000'
																	getTranscodeStream(url, ep['Id'])
																}

															} else {
																reject('emby client: cannot get episode ' + season + ':' + episode + ' from emby api for request: ' + args.id + ' / of type: ' + args.type)
															}
														})

													}
												} else {
													reject('emby client: cannot get season ' + season + ' from emby api for request: ' + args.id + ' / of type: ' + args.type)
												}
											})


										} else {
											reject('emby client: unknown stream request: ' + args.id + ' / of type: ' + args.type)
										}


									})
								})

								//builder.defineSubtitlesHandler(args => {
								  // ...
								//})

								resolver(getRouter(builder.getInterface()))

							}

							body.forEach(el => {
								serverQueue.push(el)
							})

						} else {
							console.log('emby client: server list for user ' + accessData['User']['Name'] + ' is empty')
						}

					})

				} else {
					console.log('emby client: credentials incorrect, user could not be logged in')
				}

			})
		} else {
			console.log('emby client: user and password are mandatory')
		}
	})

}

module.exports = retrieveRouter()
