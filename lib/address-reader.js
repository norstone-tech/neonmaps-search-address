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
const {phonetifyNum} = require("./phonetification");
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
 * @property {string} indexNum
 * @property {string} name
 */
const FILE_MAGIC_NUMBER = Buffer.from("neonmaps.addresses\0");
const FILE_CHECKSUM_LENGTH = 64;
const osmEnum = ["NODE", "WAY", "RELATION"];
const sParent = Symbol("parent");
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
		if(cityFirstResult == null || cityFirstResult.indexNum != fuzzNum){
			return [];
		}
		const maxFuzzNum = getMaxIndexMatch(fuzzNum);
		const results = [cityFirstResult.name];
		for(let i = cityIndex + 1; i < cities.length; i += 1){
			const cityResult = cities[i];
			if(cityResult.indexNum > maxFuzzNum){
				break;
			}
			results.push(cityResult.name);
			if(results.length >= limit){
				break;
			}
		}
		results.sort((a, b) => strDist(a, name) - strDist(b, name));
		return results;
	}
	/**
	 * @param {string | ProtoSubdivision} subdiv
	 * @returns {Promise<Map<string, ProtoStreetGroup>>} 
	 */
	async getStreetGroups(subdiv){
		if(typeof subdiv == "string"){
			subdiv = this.subdivByName(subdiv);
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
