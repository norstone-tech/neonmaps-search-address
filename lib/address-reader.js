const fs = require("fs");
const {promises: fsp} = require("fs");
const path = require("path");
const Pbf = require("pbf");
const bounds = require("binary-search-bounds");
const strDist = require("talisman/metrics/damerau-levenshtein");
const {MapReader} = require("neonmaps-base");
const {NeonmapsSearchFailError} = require("./errors");
const {
	Subdivision: SubdivisionParser,
	SubdivisionStreets: SubdivisionStreetsParser
} = require("./proto-defs");
const {phonetifyNum, expand} = require("./phonetification");
const getMaxIndexMatch = function(fuzzNum){
	let zeroPlaces = 1;
	while((fuzzNum % zeroPlaces) == 0){
		zeroPlaces *= 10;
	}
	zeroPlaces /= 10;
	return fuzzNum + zeroPlaces - 1;
}
/**
 * @typedef {import("./proto-defs").ProtoSubdivision} ProtoSubdivision
 * @typedef {import("./proto-defs").ProtoSubdivisionStreets} ProtoSubdivisionStreets
 * @typedef {import("./proto-defs").ProtoStreetGroup} ProtoStreetGroup
 */
/**
 * @typedef InternalCityIndex
 * @property {number} indexNum
 * @property {string} name
 */
/**
 * @typedef InternalSearchResult
 * @property {string} subdiv
 * @property {string} groupChar
 * @property {number} groupIndex
 * @property {number} streetIndex
 * @property {string} streetPhoneticName
 */
/**
 * @typedef StreetSearchResult
 * @property {InternalSearchResult} [_internal]
 * @property {number} osmID
 * @property {"node" | "way" | "relation"} osmType
 * @property {string} name
 * @property {string} unit
 * @property {number} streetNumber
 * @property {string} streetNumberSuffix
 * @property {string} streetName
 * @property {number} [lon]
 * @property {number} [lat]
 * @property {string} [city]
 * @property {string} [principal]
 * @property {boolean} interpolated
 */
const FILE_MAGIC_NUMBER = Buffer.from("neonmaps.addresses\0");
const FILE_CHECKSUM_LENGTH = 64;
const osmEnum = ["node", "way", "relation"];
const sParent = Symbol("parent");
const sParentIndex = Symbol("parentIndex");
class InternalPrincipalSubdiv {
	/**
	 * @param {fsp.FileHandle} fd
	 * @param {string} code
	 * @param {Buffer} pbfBuf 
	 * @param {number} streetOffsetStart 
	 * @param {number} maxSubdivCache 
	 */
	constructor(fd, pbfBuf, code, streetOffsetStart, maxSubdivCache){
		this.fd = fd;
		/**@type {ProtoSubdivision} */
		this.rootSubdiv = SubdivisionParser.read(new Pbf(pbfBuf));
		this.streetOffsetStart = streetOffsetStart;
		/**@type {Map<ProtoSubdivision, Map<string, ProtoStreetGroup> | Promise<Map<string, ProtoStreetGroup>>>} */
		this.subdivStreetCache = new Map();
		this.maxSubdivCache = maxSubdivCache;
		/**@type {Map<string, Array<InternalCityIndex>>} */
		this.cityIndex = new Map();
		/**@type {Map<string, ProtoSubdivision>} */
		this._subdivByName = new Map();
		this.countryRules = require("./country-rules/ca");
		// this.countryRules = require("./country-rules/" + code.substring(0, 2).toLowerCase());
		if(this.countryRules.boundaryRules[code]){
			this.subdivRules = Object.assign(
				Object.create(this.countryRules.boundaryRules.default),
				this.countryRules.boundaryRules[code]
			);
		}else{
			this.subdivRules = this.countryRules.boundaryRules.default;
		}
		this._mapSubdivs();
		this.cityIndex.forEach(v => v.sort((a, b) => a.indexNum - b.indexNum));
	}
	/**
	 * @param {string} name
	 * @returns {ProtoSubdivision}
	 */
	subdivByName(name){
		return this._subdivByName.get(name.toLowerCase());
	}
	_mapSubdivs(/**@type {ProtoSubdivision>}*/ subdiv = this.rootSubdiv){
		for(let i = 0; i < subdiv.subdivision.length; i += 1){
			const subsubdiv = subdiv.subdivision[i];
			subsubdiv[sParent] = subdiv;
			const lowercaseName = subsubdiv.name.toLowerCase();
			this._subdivByName.set(lowercaseName, subsubdiv);
			const [fuzzChar, fuzzNum] = phonetifyNum(lowercaseName, this.subdivRules.defaultLang, false, false);
			if(!this.cityIndex.has(fuzzChar)){
				this.cityIndex.set(fuzzChar, []);
			}
			this.cityIndex.get(fuzzChar).push({
				name: lowercaseName,
				indexNum: fuzzNum
			});
			this._mapSubdivs(subsubdiv);
		}
	}
	/**
	 * @param {string} name
	 * @param {number} limit
	 * @returns {Array<string>} 
	 */
	subdivSearch(name, limit = Infinity){
		name = name.toLowerCase();
		const [fuzzChar, fuzzNum] = phonetifyNum(name, this.subdivRules.defaultLang, false, false);
		if(!this.cityIndex.has(fuzzChar)){
			return [];
		}
		const cities = this.cityIndex.get(fuzzChar);
		const cityIndex = bounds.ge(cities, {indexNum: fuzzNum}, (a, b) => a.indexNum - b.indexNum);
		const cityFirstResult = cities[cityIndex];
		if(cityFirstResult == null){
			return [];
		}
		const maxFuzzNum = getMaxIndexMatch(fuzzNum);
		const results = [];
		for(let i = cityIndex; i < cities.length; i += 1){
			const cityResult = cities[i];
			if(cityResult.indexNum > maxFuzzNum){
				break;
			}
			results.push(cityResult.name);
			if(results.length >= limit){
				break;
			}
		}
		/**@type {Map<string, number>} */
		const strDists = new Map();
		for(let i = 0; i < results.length; i += 1){
			strDists.set(results[i], strDist(results[i], name));
		}
		results.sort((a, b) => strDists.get(a) - strDists.get(b));
		return results;
	}
	/**
	 * @param {string | ProtoSubdivision} subdiv
	 * @returns {Promise<Map<string, ProtoStreetGroup>>} 
	 */
	async getStreetGroups(subdiv){
		if(typeof subdiv == "string"){
			subdiv = this.subdivByName(subdiv);
			if(!subdiv){
				return null;
			}
		}
		if(this.subdivStreetCache.has(subdiv)){
			const result = this.subdivStreetCache.get(subdiv);
			this.subdivStreetCache.delete(subdiv);
			this.subdivStreetCache.set(subdiv, result);
			return result;
		}
		if(subdiv.streetLength == 0){
			return new Map();
		}
		const resultPromise = (async () => {
			const pbfBuf = (await this.fd.read(
				Buffer.allocUnsafe(subdiv.streetLength),
				0,
				subdiv.streetLength,
				subdiv.streetOffset
			)).buffer;
			/**@type {ProtoSubdivisionStreets} */
			const {streetGroups} = SubdivisionStreetsParser.read(new Pbf(pbfBuf));
			const result = new Map();
			for(let i = 0; i < streetGroups.length; i += 1){
				const streetGroup = streetGroups[i];
				streetGroups[sParent] = subdiv;
				result.set(String.fromCharCode(streetGroup.groupIndex), streetGroup);
			}
			return result;
		})();
		this.subdivStreetCache.set(subdiv, resultPromise);
		const result = await resultPromise;
		if(this.subdivStreetCache.has(subdiv)){
			this.subdivStreetCache.set(subdiv, result);
		}
		while(this.subdivStreetCache.size > this.maxSubdivCache){
			this.subdivStreetCache.delete(this.subdivStreetCache.keys().next().value);
		}
		return result;
	}
	/**
	 * @param {string | ProtoSubdivision} subdiv
	 * @returns {Promise<Array<Map<string, ProtoStreetGroup>>>} 
	 */
	async getStreetGroupsRecursive(subdiv){
		if(typeof subdiv == "string"){
			subdiv = this.subdivByName(subdiv);
			if(!subdiv){
				return null;
			}
		}
		const result = [await this.getStreetGroups(subdiv)];
		if(result[0].size == 0){
			result.pop();
		}
		for(let i = 0; i < subdiv.subdivision.length; i += 1){
			result.push(...await this.getStreetGroupsRecursive(subdiv.subdivision[i]));
		}
		return result;
	}
	/**
	 * @param {string} unit
	 * @param {number} streetNumber
	 * @param {string} streetNumberSuffix
	 * @param {string} street
	 * @param {string} city
	 * @param {number} limit
	 * @returns {Array<StreetSearchResult>}
	 */
	async searchAddress(unit, streetNumber, streetNumberSuffix, street, city, limit = Infinity){
		const streetGroupMaps = await this.getStreetGroupsRecursive(city);
		if(!streetGroupMaps){
			throw new NeonmapsSearchFailError("city/division " + city + " not found");
		}
		if(!streetGroupMaps.length){
			throw new NeonmapsSearchFailError(city + " has no known addresses");
		}
		const phoneticStreet = expand(street, this.subdivRules.defaultLang);
		const [fuzzChar, fuzzNum] = phonetifyNum(phoneticStreet, this.subdivRules.defaultLang, true, false);
		/**@type {Array<ProtoStreetGroup>} */
		const streetGroups = [];
		for(let i = 0; i < streetGroupMaps.length; i += 1){
			const map = streetGroupMaps[i];
			if(map.has(fuzzChar)){
				streetGroups.push(map.get(fuzzChar));
			}
		}
		// I'm doing it this way because I want to mix the results within subdivisions together
		const streetGroupIndexes = [];
		for(let i = 0; i < streetGroups.length; i += 1){
			const streetGroup = streetGroups[i];
			/**@type {number} */
			let ii = bounds.ge(streetGroup.streetIndex, fuzzNum);
			if(ii >= streetGroup.streetIndex.length){
				ii = -1;
			}
			streetGroupIndexes.push(ii);
		}
		const maxFuzzNum = getMaxIndexMatch(fuzzNum);
		const streets = [];
		while(streetGroups.length){
			for(let i = streetGroups.length - 1; i >= 0; i += 1){
				if(streetGroupIndexes[i] == -1){
					streetGroupIndexes.splice(i, 1);
					streetGroups.splice(i, 1);
					continue;
				}
				const streetGroup = streetGroups[i];
				const streetGroupIndex = streetGroupIndexes[i];
				if(streetGroup.streetIndex[streetGroupIndex] > maxFuzzNum){
					streetGroupIndexes[i] = -1;
					continue;
				}
				if(
					streetGroup.streetMinNum[streetGroupIndex] > streetNumber ||
					streetGroup.streetMaxNum[streetGroupIndex] < streetNumber
				){
					continue;
				}
				streetGroup.streets[streetGroupIndex][sParent] = streetGroup;
				streetGroup.streets[streetGroupIndex][sParentIndex] = streetGroupIndex;
				streets.push(streetGroup.streets[streetGroupIndex]);
				if(streets.length >= limit){
					break;
				}
				if((streetGroupIndexes[i] += 1) > streetGroups.length){
					streetGroupIndexes[i] = -1;
				}
			}
		}
		/**@type {Map<string, number>} */
		const streetDists = new Map();
		/**@type {Array<StreetSearchResult>} */
		const results = [];
		for(let i = 0; i < streets.length; i += 1){
			const street = streets[i];
			streetDists.set(street.streetPhoneticName, strDist(street.streetPhoneticName, phoneticStreet));
			let searchInterpolation = true;
			let streetIndex = bounds.ge(street.streetNumber, streetNumber);
			while(street.streetNumber[streetIndex] == streetNumber){
				searchInterpolation = false;
				const result = {
					_internal: {
						groupChar: fuzzChar,
						groupIndex: street[sParentIndex],
						streetIndex,
						streetPhoneticName: street.streetPhoneticName,
						subdiv: street[sParent][sParent].name.toLowerCase()
					},
					osmID: street.item[streetIndex],
					osmType: osmEnum[street.itemType[streetIndex]],
					name: street.itemName[streetIndex],
					unit: street.unitNumber[streetIndex],
					streetNumber: street.streetNumber[streetIndex],
					streetNumberSuffix: street.streetNumberSuffix[streetIndex],
					streetName: street.streetFullName,
					interpolated: false
				}
				streetIndex += 1;
				if(unit && result.unit && !result.unit.startsWith(unit)){
					continue;
				}
				if(
					streetNumberSuffix &&
					result.streetNumberSuffix &&
					!result.streetNumberSuffix.startsWith(streetNumberSuffix)
				){
					continue;
				}
				results.push(result);
				
			}
			if(searchInterpolation){
				streetIndex = bounds.ge(street.interpolationStart, streetNumber);
				if(streetIndex == street.interpolationStart.length){
					streetIndex -= 1;
				}
				while(street.interpolationEnd[streetIndex] <= streetNumber){
					if(
						((
							streetNumber - street.interpolationStart[streetIndex]
						) % street.interpolationMul[streetIndex]) === 0
					){
						results.push({
							_internal: {
								groupChar: fuzzChar,
								groupIndex: street[sParentIndex],
								streetIndex,
								streetPhoneticName: street.streetPhoneticName,
								subdiv: street[sParent][sParent].name.toLowerCase()
							},
							osmID: street.interpolations[streetIndex],
							osmType: "way",
							name: "",
							unit: "",
							streetNumber,
							streetNumberSuffix: "",
							streetName: street.streetFullName,
							interpolated: true
						});
					}
					streetIndex += 1;
				}
			}
		}
		if(!results.length){
			throw new NeonmapsSearchFailError("Address not found on specified street");
		}
		results.sort(
			(a, b) => streetDists.get(a._internal.streetPhoneticName) - streetDists.get(b._internal.streetPhoneticName)
		);
		return results;
	}
}
class AddressReader{
	/**
	 * @param {MapReader} mapReader 
	 * @param {string} countryCode 
	 * @param {number} maxPrincipalCache
	 * @param {number} maxSubdivCache
	 */
	constructor(mapReader, countryCode){
		this.mapReader = mapReader;
		const mapPath = this.mapReader.filePath;
		const mapName = mapPath.substring(mapPath.lastIndexOf(path.sep) + 1, mapPath.length - ".osm.pbf".length);
		const filePath = path.resolve(
			mapPath, "..", mapName + ".neonmaps." + countryCode.toLowerCase() + ".addresses"
		);
		
		this.filePath = filePath;
		/**@type {Map<string, InternalPrincipalSubdiv | Promise<InternalPrincipalSubdiv>>} */
		this.principalSubdivs = new Map();
		/**@type {Map<string, number>} */
		this.principalSubdivOffset = new Map();
		/**@type {Map<string, number>} */
		this.principalSubdivLength = new Map();
		this.countryCode = countryCode.toUpperCase();
		this.maxPrincipalCache = this.maxPrincipalCache;
		this.maxSubdivCache = this.maxSubdivCache;
	}
	async init(){
		try{
			this.fd = await fsp.open(this.filePath);
			if(!(
				await this.fd.read(Buffer.allocUnsafe(FILE_MAGIC_NUMBER.length), 0, FILE_MAGIC_NUMBER.length, 0)
			).buffer.equals(FILE_MAGIC_NUMBER)){
				throw new Error("File is not an neonmaps.address file!")
			}
			if(
				this.mapReader.checksum &&
				!(
					await this.fd.read(Buffer.allocUnsafe(FILE_CHECKSUM_LENGTH), 0, FILE_CHECKSUM_LENGTH, 0)
				).buffer.equals(await this.mapReader.checksum)
			){
				throw new Error("Address file doesn't match with map file!")
			}
			let fileOffset = FILE_MAGIC_NUMBER.length + FILE_CHECKSUM_LENGTH;
			const subdivCodeBuf = Buffer.allocUnsafe(3);
			const subdivLenBuf = Buffer.allocUnsafe(4);
			while(true){
				await this.fd.read(subdivCodeBuf, 0, subdivCodeBuf.length, fileOffset);
				const subdivCode = subdivCodeBuf.toString("ascii").trim();
				fileOffset += 3;
				if(!subdivCode){
					break;
				}
				await this.fd.read(subdivLenBuf, 0, subdivLenBuf.length, fileOffset);
				this.principalSubdivOffset.set(subdivCode, fileOffset += 4);
				this.principalSubdivLength.set(subdivCode, subdivLenBuf.readUInt32LE());
			}
			this.streetOffsetStart = fileOffset;
		}catch(ex){
			if(this.fd != null){
				this.fd.close().catch(Function.prototype);
				this.fd = null;
			}
			throw ex;
		}
	}
	/**
	 * @param {string} code
	 * @returns {InternalPrincipalSubdiv} 
	 */
	async getPrincipalSubdiv(code){
		if(this.principalSubdivs.has(code)){
			const result = this.principalSubdivs.get(code);
			this.principalSubdivs.delete(code);
			this.principalSubdivs.set(code, result);
			return result;
		}
		if(!this.principalSubdivOffset.has(code)){
			throw new NeonmapsSearchFailError("Cannot find country subdivision " + this.countryCode + "-" + code);
		}
		const resultPromise = (async () => {
			const pbfSize = this.principalSubdivLength.get(code);
			const pbfOffset = this.principalSubdivOffset.get(code);
			const pbfBuf = (await this.fd.read(Buffer.allocUnsafe(pbfSize), 0, pbfSize, pbfOffset)).buffer;
			return new InternalPrincipalSubdiv(
				this.fd,
				pbfBuf,
				this.countryCode + "-" + code,
				this.streetOffsetStart,
				this.maxSubdivCache
			);
		})();
		this.principalSubdivs.set(code, resultPromise);
		const result = await resultPromise;
		if(this.principalSubdivs.has(code)){
			this.principalSubdivs.set(code, result);
		}
		while(this.principalSubdivs.size > this.maxPrincipalCache){
			this.principalSubdivs.delete(this.principalSubdivs.keys().next().value);
		}
		return result;
	}
	async stop(){
		if(this.fd != null){
			await this.fd.close();
			this.fd = null;
		}
	}
}
module.exports = {AddressReader};
