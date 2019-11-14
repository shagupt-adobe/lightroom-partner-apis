const request = require('request-promise')
const crypto = require('crypto')
const adobeApiKey = require('../public/config').adobeApiKey
const _lrEndpoint = 'https://lr.adobe.io'

function _createUuid() {
	// helper function for generating a Lightroom unique identifier
	let bytes = crypto.randomBytes(16)
	bytes[6] = bytes[6] & 0x0f | 0x40
	bytes[8] = bytes[8] & 0x3f | 0x80
	return bytes.toString('hex')
}

let Lr = {
	util: {
		// utility to check the health of the Lightroom services
		getHealthP: function() {
			let options = {
				uri: `${_lrEndpoint}/v2/health`,
				headers: {
					'X-API-Key': adobeApiKey,
					method: 'GET'
				}
			}
			return request(options)
				.then((result) => {
					return 'Lightroom Services are up'
				})
				.catch((error) => {
					return Promise.reject('Lightroom Services are down')
				})
		},

		// utility to get the user account
		getAccountP: function(token) {
			if (!token) {
				return Promise.reject('get account failed: no user token')
			}
			return Lr.getJSONP(token, '/v2/accounts/me')
				.then((account) => {
					return account
				})
				.catch((error) => {
					return Promise.reject(`get account failed with error: ${error.statusCode}`)
				})
		},

		// utility to get the user catalog
		getCatalogP: function(token) {
			if (!token) {
				return Promise.reject('get catalog failed: no user token')
			}
			return Lr.getJSONP(token, '/v2/catalogs/mine')
				.then((catalog) => {
					return catalog
				})
				.catch((error) => {
					return Promise.reject(`get catalog failed with error: ${error.statusCode}`)
				})
		},

		// utility to get the project albums
		getProjectsP: function(token, catalog_id) {
			if (!token) {
				return Promise.reject('get project albums failed: no user token')
			}
			return Lr.getJSONP(token, `/v2/catalogs/${catalog_id}/albums?subtype=project`)
				.then((projects) => {
					let resources = projects.resources.filter((project) => project.payload.publishInfo && (project.payload.publishInfo.serviceId == adobeApiKey))
					projects.resources = resources
					return projects
				})
				.catch((error) => {
					return Promise.reject(`get projects failed with error: ${error.statusCode}`)
				})
		},

		// utility to create a project album
		createProjectP: function(token, catalog_id) {
			if (!token) {
				return Promise.reject('create project failed: no user token')
			}

			// create a new project populating the required JSON data.
			let album_id = _createUuid()
			let importTimestamp = (new Date()).toISOString()
			let content = {
				subtype: 'project',
				serviceId: adobeApiKey,
				payload: {
					userCreated: importTimestamp,
					userUpdated: importTimestamp,
					name: album_id, // just use album id for now
					publishInfo: {
						version: 2,
						serviceId: adobeApiKey
					}
				}
			}

			return Lr.putJSONP(token, `/v2/catalogs/${catalog_id}/albums/${album_id}`, content)
				.then((response) => {
					return `created project with id ${album_id}`
				})
				.catch((error) => {
					return Promise.reject(`create project failed with error: ${error.statusCode}`)
				})
		},

		// utility function to create a new asset revision and upload its master
		uploadImageP: async function(token, importedBy, catalog_id, fileName, data) {
			// new revision url
			let asset_id = _createUuid()
			let revision_id = _createUuid()
			let revisionUrl = `/v2/catalogs/${catalog_id}/assets/${asset_id}/revisions/${revision_id}`

			function _createRevisionP() {
				// create a new asset revision by populating the required JSON data.
				let importTimestamp = (new Date()).toISOString()
				let content = {
					subtype: 'image',
					payload: {
						captureDate: '0000-00-00T00:00:00',
						userCreated: importTimestamp,
						userUpdated: importTimestamp,
						importSource: {
							fileName: fileName,
							importTimestamp: importTimestamp,
							importedBy: importedBy,
							importedOnDevice: adobeApiKey
						}
					}
				}
				let sha256 = crypto.createHash('sha256').update(data).digest('hex')
				return Lr.putJSONP(token, revisionUrl, content, sha256)
					.catch((error) => {
						if (error.statusCode == 412) {
							return Promise.reject('create revision failed: duplicate found')
						}
						return Promise.reject(`create revision failed: error status ${error.statusCode}`)
					})
			}

			function _putMasterP() {
				let relativeUrl = `${revisionUrl}/master`
				let contentType = 'application/octet-stream'
				let contentRange = `bytes 0-${data.length - 1}/${data.length}`
				return Lr.putMasterP(token, relativeUrl, contentType, contentRange, data)
					.catch((error) => {
						return Promise.reject(`upload failed: put master error status ${error.statusCode}`)
					})
			}

			await _createRevisionP()
			return _putMasterP().then(() => {
				return asset_id
			})
		},

		uploadImageAndAddToFirstProjectP: async function(token, importedBy, catalog_id, fileName, data) {
			let response = await Lr.util.getProjectsP(token, catalog_id)
			if (response.resources.length == 0) {
				return 'Error: no first project'
			}
			let album_id = response.resources[0].id
			let asset_id = await Lr.util.uploadImageP(token, importedBy, catalog_id, fileName, data)
			let content = { resources: [ { id: asset_id } ] }
			return Lr.putJSONP(token, `/v2/catalogs/${catalog_id}/albums/${album_id}/assets`, content)
				.then((response) => {
					return asset_id
				})
				.catch((error) => {
					return Promise.reject(`add asset to album failed: error status ${error.statusCode}`)
				})
		}
	},

	// function to fetch JSON from a Lightroom services endpoint. all JSON that is
	// returned is guarded with a while(1){} preface to thwart malicious activity.
	// need to strip the preface before converting the result to a JavaScript object.
	getJSONP: function(token, relativeUrl) {
		function _processJSONResponse(response) {
			let while1Regex = /^while\s*\(\s*1\s*\)\s*{\s*}\s*/
			return response ? JSON.parse(response.replace(while1Regex, '')) : null
		}
		let options = {
			uri: `${_lrEndpoint}${relativeUrl}`,
			headers: {
				'X-API-Key': adobeApiKey,
				Authorization: `Bearer ${token}`,
				method: 'GET'
			}
		}
		return request(options).then(_processJSONResponse)
	},

	// function to put JSON to a Lightroom services endpoint. this function is
	// used to create new asset revisions, so it takes an optional SHA-256
	// value to populate the "If-None-Match" header, if it is present.
	putJSONP: function(token, relativeUrl, content, sha256) {
		let options = {
			uri: `${_lrEndpoint}${relativeUrl}`,
			headers: {
				'X-API-Key': adobeApiKey,
				Authorization: `Bearer ${token}`,
				method: 'PUT',
				'Content-Type': 'application/json'
			},
			body: content,
			json: true
		}
		if (sha256) {
			options.headers['If-None-Match'] = sha256
		}
		return request.put(options)
	},

	// function to upload a buffer containing image or video data. may be called
	// multiple times if the object is broken into chunks, so it takes in the
	// Content-Range value. always makes a reuqest for Lightroom to generate all
	// of the renditions associated with the asset, when the upload is complete.
	putMasterP: function(token, relativeUrl, contentType, contentRange, data) {
		let options = {
			uri: `${_lrEndpoint}${relativeUrl}`,
			headers: {
				'X-API-Key': adobeApiKey,
				Authorization: `Bearer ${token}`,
				method: 'PUT',
				'Content-Type': contentType,
				'Content-Range': contentRange,
				'X-Generate-Renditions': 'all'
			},
			body: data
		}
		return request.put(options)
	}

}

module.exports = Lr
