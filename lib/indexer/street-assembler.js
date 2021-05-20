const path = require("path");
const fs = require("fs");
const {promises: fsp} = require("fs");
const turf = require("@turf/helpers");
const {MapReader} = require("neonmaps-base");
const {default: geoCentroid} = require("@turf/centroid");
const {default: geoDistance} = require("@turf/distance");
const {geoContainsMultiPolygon, logProgressMsg} = require("../util");
const Pbf = require("pbf");
const {
	StreetAddresses: StreetAddressParser,
	Subdivision: SubdivisionParser,
	SubdivisionStreets: SubdivisionStreetsParser
} = require("../proto-defs");
const {
	sCentroid,
	sDistance,
	sSubDivision,
	sOSMID,
	sOSMType
} = require("./symbols");
const sStreetGroupIndex = Symbol("streetGroupIndex");
const sStreetIndexNum = Symbol("streetIndexNum");
const sStreetMinNum = Symbol("streetMinNum");
const sStreetMaxNum = Symbol("streetMaxNum");

const {
	expand,
	phonetifyNum
} = require("../phonetification");
const enumElemType = {
	node: 0,
	way: 1,
	relation: 2
};
const replaceFractionsTable = {
	"¼": "(1/4)",
	"½": "(1/2)",
	"¾": "(3/4)",
	"⅐": "(1/7)",
	"⅑": "(1/9)",
	"⅒": "(1/10)",
	"⅓": "(1/3)",
	"⅔": "(2/3)",
	"⅕": "(1/5)",
	"⅖": "(2/5)",
	"⅗": "(3/5)",
	"⅘": "(4/5)",
	"⅙": "(1/6)",
	"⅚": "(5/6)",
	"⅛": "(1/8)",
	"⅜": "(3/8)",
	"⅝": "(5/8)",
	"⅞": "(7/8)"
}
const replaceFractions = function(/**@type {string}*/ str){
	return str.replace(/[¼½¾⅐⅑⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞⅒]/g, match => replaceFractionsTable[match]);
}
class StreetAssembler{
	/**
	 * @param {string} tmpDir 
	 * @param {MapReader} mapReader
	 * @param {string} country
	 * @param {Array<turf.Feature<turf.Polygon | turf.MultiPolygon>>} subDivisions
	 * @param {number} cacheAmount
	 */
	constructor(tmpDir, mapReader, country, subDivisions, cacheAmount){
		const mapPath = mapReader.filePath;
		this.dir = tmpDir + path.sep + "addresses";
		this.mapReader = mapReader;
		if(country != "CA"){
			throw new Error("todo");
		}
		this.countryRules = require("../country-rules/ca");
		this.subdivRules = {};
		for(const k in this.countryRules.boundaryRules){
			if(k == "default"){
				continue;
			}
			this.subdivRules[k] = Object.assign(
				Object.create(this.countryRules.boundaryRules.default),
				this.countryRules.boundaryRules[k]
			);
		}
		this.subDivisions = subDivisions;
		this.maxCacheAmount = cacheAmount;
		/**@type {Map<string, import("../proto-defs").ProtoStreetAddresses>} */
		this.cache = new Map();
		const mapName = mapPath.substring(mapPath.lastIndexOf(path.sep) + 1, mapPath.length - ".osm.pbf".length);
		this.finalFilePath = path.resolve(mapPath, "..", mapName + ".neonmaps.addresses");
		/**@type {Map<string, Promise<void>>} */
		this.cacheWrites = new Map();
	}
	/**
	 * 
	 * @param {string} subdivPath 
	 * @returns {import("../proto-defs").ProtoStreetAddresses>}
	 */
	async getStreetData(subdivPath){
		if(this.cacheWrites.has(subdivPath)){
			await this.cacheWrites.get(subdivPath);
		}
		if(this.cache.has(subdivPath)){
			const result = this.cache.get(subdivPath);
			this.cache.delete(subdivPath);
			this.cache.set(subdivPath, result);
			return result;
		}
		try{
			const result = StreetAddressParser.read(new Pbf(
				await fsp.readFile(path.resolve(this.dir, subdivPath + ".pbf"))
			));
			this.cache.set(subdivPath, result);
			await this.cleanCache();
			return result;
		}catch(ex){
			if(ex.code != "ENOENT"){
				throw ex;
			}
		}
		/**@type {import("../proto-defs").ProtoStreetAddresses>} */
		const result = {
			streetFullName: "",
			item: [],
			itemType: [],
			itemName: [],
			unitNumber: [],
			streetNumber: [],
			streetNumberSuffix: [],
			interpolations: [],
			interpolationStart: [],
			interpolationMul: [],
			interpolationEnd: []
		};
		this.cache.set(subdivPath, result);
		this.cleanCache();
		return result;
	}
	/**
	 * @private
	 * @param {string} subdivPath
	 * @param {Buffer} buffer
	 */
	async _writeStreetData(subdivPath, buffer){
		const fullPath = path.resolve(this.dir, subdivPath + ".pbf");
		await fsp.mkdir(path.resolve(fullPath, ".."), {recursive: true})
		await fsp.writeFile(fullPath, buffer);
		this.cacheWrites.delete(subdivPath);
	}
	saveStreetData(subdivPath){
		const data = this.cache.get(subdivPath);
		const pbf = new Pbf();
		StreetAddressParser.write(data, pbf);
		const pbfBuf = pbf.finish();
		this.cache.delete(subdivPath);
		this.cacheWrites.set(subdivPath, this._writeStreetData.bind(this)(subdivPath, pbfBuf));
	}
	cleanCache(){
		while (this.cache.size > this.maxCacheAmount){
			this.saveStreetData(this.cache.keys().next().value);
		}
	}
	
	/**
	 * 
	 * @param {Array<turf.Feature<turf.Polygon | turf.MultiPolygon>>} subdivs 
	 * @param {turf.Feature} place
	 * @param {string} curpath
	 * @returns {[turf.Feature<turf.Polygon | turf.MultiPolygon>, string]}
	 */
	_actuallyGetSubdiv(subdivs, place, curpath){
		for(let i = 0; i < subdivs.length; i += 1){
			subdivs[i][sDistance] = geoDistance(subdivs[i][sCentroid], place[sCentroid]);
		}
		subdivs.sort((a, b) => a[sDistance] - b[sDistance]);
		for(let i = 0; i < subdivs.length; i += 1){
			const subdiv = subdivs[i];
			/* Checking centroid because sometimes a border might cut through a building. Though this won't work in the
			   case where an administrative border is entirely contained by a single building. But nothing like that
			   exists, right? */
			if(geoContainsMultiPolygon(subdiv, place[sCentroid])){
				if(subdiv[sSubDivision]){
					return this._actuallyGetSubdiv(
						subdiv[sSubDivision],
						place,
						curpath + subdiv.properties.name.replace(/\/\\\?\>\<\:\*\|"/, "_") + path.sep
					);
				}
				return [subdiv, curpath + subdiv.properties.name];
			}
		}
		return [null, ""];
	}
	/**
	 * @param {string} nameOrPath
	 * @returns {string}
	 */
	getPrincipalCode(nameOrPath){
		const principalName = nameOrPath.substring(0, nameOrPath.indexOf(path.sep)) || nameOrPath;
		for(let i = 0; i < this.subDivisions.length; i += 1){
			if(this.subDivisions[i].properties.name == principalName){
				return this.subDivisions[i].properties["ISO3166-2"];
			}
		}
		return "";
	}
	/**
	 * @param {turf.Feature} place
	 * @returns {[string, turf.Feature<turf.Polygon | turf.MultiPolygon>, string]}
	 */
	getSubdiv(place){
		const [subdiv, subdivPath] = this._actuallyGetSubdiv(this.subDivisions, place, "");
		return [this.getPrincipalCode(subdivPath), subdiv, subdivPath];
	}
	async indexPlaces(){
		const mapSize = (await fsp.stat(this.mapReader.filePath)).size;
		let fileOffset = (await this.mapReader.readMapSegment(0))._byte_size;
		while(fileOffset < mapSize){
			const rawData = await this.mapReader.readMapSegment(fileOffset);
			const mapData = MapReader.decodeRawData(rawData);
			const mapThings = [...mapData.nodes, ...mapData.ways, ...mapData.relations];
			for(let i = 0; i < mapThings.length; i += 1){
				const place = mapThings[i];
				if(place.tags.has("addr:interpolation") && place.type == "way"){
					const interpolation = place.tags.get("addr:interpolation");
					if(interpolation == "alphabetic"){
						console.warn("WARNING: TODO: addr:interpolation=alphabetic");
						continue;
					}
					const firstNode = await this.mapReader.getNode(place.nodes[0]);
					if(!firstNode.tags.has("addr:housenumber") || !firstNode.tags.has("addr:street")){
						console.warn(
							"WARNING: First node defined in interpolation way " + place.id +
							" doesn't have an address defined!"
						);
						continue;
					}
					const firstNodeGeo = await this.mapReader.getNodeGeoJSON(firstNode);
					firstNodeGeo[sCentroid] = firstNodeGeo;
					const [principalSubdivCode, subdiv, subdivPath] = this.getSubdiv(firstNodeGeo);
					if(!principalSubdivCode){
						console.warn("WARNING: unable to get subdivision for way " + place.id);
						continue;
					}
					const interpolationNum = interpolation == "all" ? 1 : (isNaN(interpolation) ? 2 : Number(interpolation));
					let minValue = Infinity;
					let maxValue = -Infinity;
					for(let ii = 0; ii < place.nodes.length; ii += 1){
						const node = await this.mapReader.getNode(place.nodes[ii]);
						if(!node.tags.has("addr:housenumber")){
							continue;
						}
						const houseNumParts = replaceFractions(
							node.tags.get("addr:housenumber")
						).match(this.countryRules.houseNumberParser);
						if(houseNumParts == null){
							console.warn(
								"WARNING: Unable to parse address \"" + node.tags.get("addr:housenumber") +
								"\" for node " + node.id
							);
							continue;
						}
						const houseNumber = Number(houseNumParts[this.countryRules.houseNumberArrangement[0]]);
						if(houseNumber > maxValue){
							maxValue = houseNumber;
						}
						if(houseNumber < minValue){
							minValue = houseNumber;
						}
					}
					if(minValue == Infinity){
						console.warn(
							"WARNING: Interpolation way " + place.id +
							" has no nodes with valid street numbers!"
						);
						continue;
					}
					const fullStreetName = firstNode.tags.get("addr:street");
					const streetPath = subdivPath + path.sep + fullStreetName;
					const streetData = await this.getStreetData(streetPath);
					streetData.interpolations.push(place.id);
					streetData.interpolationStart.push(minValue);
					streetData.interpolationMul.push(interpolationNum);
					streetData.interpolationEnd.push(maxValue);
					continue;
				}
				if(!place.tags.has("addr:housenumber") || !place.tags.has("addr:street")){
					continue;
				}
				if(place.tags.has("addr:flats")){
					console.warn("WARNING: TODO: addr:flats -> unit number interpolation");
				}
				const houseNumParts = replaceFractions(
					place.tags.get("addr:housenumber")
				).match(this.countryRules.houseNumberParser);
				if(houseNumParts == null){
					console.warn(
						"WARNING: Unable to parse address \"" + place.tags.get("addr:housenumber") + "\" for " +
						place.type + " " + place.id
					);
					continue;
				}
				const placeGeometry = place.type == "node" ?
					await this.mapReader.getNodeGeoJSON(place) :
					(
						place.type == "way" ?
						await this.mapReader.getWayGeoJSON(place) :
						await this.mapReader.getRelationGeoJSON(place)
					);
				if(placeGeometry == null){
					console.warn("WARNING: " + place.type + " " + place.id + " has no (valid) geometry!");
					continue;
				}
				if(place.type == "node"){
					placeGeometry[sCentroid] = placeGeometry;
				}else{
					placeGeometry[sCentroid] = geoCentroid(placeGeometry);
				}
				const [principalSubdivCode, subdiv, subdivPath] = this.getSubdiv(placeGeometry);
				if(!principalSubdivCode){
					console.warn("WARNING: unable to get subdivision for " + place.type + " " + place.id);
					continue;
				}
				const houseUnit = place.tags.has("addr:unit") ? place.tags.get("addr:unit") : "";
				const houseNumber = Number(houseNumParts[this.countryRules.houseNumberArrangement[0]]);
				const houseNumberSuffix = houseNumParts[this.countryRules.houseNumberArrangement[1]] ?? "";
				const fullStreetName = place.tags.get("addr:street");
				const streetPath = subdivPath + path.sep + fullStreetName;

				const streetData = await this.getStreetData(streetPath);
				if(!streetData.streetFullName){
					streetData.streetFullName = fullStreetName;
					streetData.streetPhoneticName = expand(
						fullStreetName,
						(this.subdivRules[principalSubdivCode] || this.countryRules.boundaryRules.default).defaultLang
					);
				}
				let placeName = "";
				if(place.tags.has("ref")){
					placeName += place.tags.get("ref") + " - ";
				}
				placeName += place.tags.get("name") ||
					place.tags.get("brand") ||
					place.tags.get("amenity") ||
					place.tags.get("building") || "";
				if(placeName.endsWith(" - ")){
					placeName = placeName.substring(0, placeName.length - 3);
				}
				streetData.unitNumber.push(houseUnit);
				streetData.streetNumber.push(houseNumber);
				streetData.streetNumberSuffix.push(houseNumberSuffix);
				streetData.item.push(place.id);
				streetData.itemType.push(enumElemType[place.type])
				streetData.itemName.push(placeName);
			}
			fileOffset += rawData._byte_size;
			logProgressMsg(
				"Street address resolving: " + fileOffset + "/" + mapSize + " (" +
				(fileOffset / mapSize * 100).toFixed(2) +
				"%)"
			);
		}
		while(this.cache.size > 0){
			this.saveStreetData(this.cache.keys().next().value);
		}
		await Promise.all(this.cacheWrites.values());
		console.log("Street address resolving: " + fileOffset + "/" + mapSize + " (100%)");
	}
	_createProtoSubdivs(subdivs = this.subDivisions){
		/**@type {Array<import("../proto-defs").ProtoSubdivision>} */
		const result = [];
		for(let i = 0; i < subdivs.length; i += 1){
			const subdiv = subdivs[i];
			/**@type {turf.Feature<turf.Point>} */
			const centroid = subdiv[sCentroid];
			result.push({
				name: subdiv.properties.name,
				osmID: subdiv[sOSMID],
				osmType: subdiv[sOSMType],
				lat: centroid.geometry.coordinates[1],
				lon: centroid.geometry.coordinates[0],
				subdivision: this._createProtoSubdivs(subdiv[sSubDivision] || [])
			});
		}
		return result;
	}
	_flattenProtoSubdivs(
		/**@type {Array<import("../proto-defs").ProtoSubdivision>}*/ protoSubdivs,
		/**@type {string}*/ curPath = "",
		/**@type {Map<string, import("../proto-defs").ProtoSubdivision>}*/ result = new Map()
	){
		for(let i = 0; i < protoSubdivs.length; i += 1){
			const protoSubdiv = protoSubdivs[i];
			const subdivPath = curPath ? (curPath + path.sep + protoSubdiv.name) : protoSubdiv.name;
			result.set(subdivPath, protoSubdiv);
			this._flattenProtoSubdivs(
				protoSubdiv.subdivision,
				subdivPath,
				result
			);
		}
		return result;
	}
	async createFile(){
		let subdivProcessed = 0;
		const mapPath = this.mapReader.filePath;
		const mapName = mapPath.substring(mapPath.lastIndexOf(path.sep) + 1, mapPath.length - ".osm.pbf".length);
		const filePath = path.resolve(mapPath, "..", mapName + ".neonmaps.ca.addresses");
		const fileStream = fs.createWriteStream(filePath);
		const magic = "neonmaps.addresses\0";
		fileStream.write(magic);
		fileStream.write(await this.mapReader.checksum);

		const tmpStreetsPath = path.resolve(this.dir, "..", "street_groups");
		const tmpStreetsStream = fs.createWriteStream(tmpStreetsPath);
		let streetsOffset = 0;
		const protoSubdivs = this._createProtoSubdivs();
		const flatProtoSubdivs = this._flattenProtoSubdivs(protoSubdivs);

		for(const [subdivPath, subdiv] of flatProtoSubdivs){
			const subdivLang = (
				this.subdivRules[this.getPrincipalCode(subdivPath)] ||
				this.countryRules.boundaryRules.default
			).defaultLang
			const streets = [];
			try{
				const streetFileNames = (await fsp.readdir(path.resolve(this.dir, subdivPath))).filter(
					v => v.endsWith(".pbf")
				);
				for(let i = 0; i < streetFileNames.length; i += 1){
					/**@type {import("../proto-defs").ProtoStreetAddresses} */
					const protoAddr = StreetAddressParser.read(new Pbf(
						await fsp.readFile(path.resolve(this.dir, subdivPath, streetFileNames[i]))
					));
					const addresses = protoAddr.item.map((id, i) => {
						return {
							id,
							type: protoAddr.itemType[i],
							name: protoAddr.itemName[i],
							unitNumber: protoAddr.unitNumber[i],
							streetNumber: protoAddr.streetNumber[i],
							streetNumberSuffix: protoAddr.streetNumberSuffix[i]
						}
					});
					const interpolations = protoAddr.interpolations.map((id, i) => {
						return {
							id,
							start: protoAddr.interpolationStart[i],
							mul: protoAddr.interpolationMul[i],
							end: protoAddr.interpolationEnd[i]
						}
					});
					for(let i = 0; i < interpolations.length; i += 1){
						const interWay = await this.mapReader.getWay(interpolations[i].id);
						for(let ii = 0; ii < interWay.nodes.length; ii += 1){
							const addressIndex = addresses.findIndex(v => v.type == 0 && v.id == interWay.nodes[ii]);
							if(addressIndex >= 0){
								addresses.splice(addressIndex, 1);
							}
						}
					}
					addresses.sort((a, b) => {
						let numDif = a.streetNumber - b.streetNumber;
						if(numDif != 0){
							return numDif;
						}
						numDif = a.streetNumberSuffix.length - b.streetNumberSuffix.length;
						if(numDif != 0){
							// place buildings without number suffixes below those which do
							if(!a.streetNumberSuffix.length){
								return 1;
							}
							if(!b.streetNumberSuffix.length){
								return -1;
							}
							return numDif;
						}
						if(a.streetNumberSuffix < b.streetNumberSuffix){
							return -1;
						}
						if(a.streetNumberSuffix > b.streetNumberSuffix){
							return 1;
						}
						numDif = a.unitNumber.length - b.unitNumber.length;
						if(numDif != 0){
							// place buildings without uinit numbers below those which do
							if(!a.unitNumber.length){
								return 1;
							}
							if(!b.unitNumber.length){
								return -1;
							}
							return numDif;
						}
						if(a.unitNumber < b.unitNumber){
							return -1;
						}
						if(a.unitNumber > b.unitNumber){
							return 1;
						}
						return 0;
					});
					interpolations.sort((a, b) => a.start - b.start);
					protoAddr.item.length = 0;
					protoAddr.itemType.length = 0;
					protoAddr.itemName.length = 0;
					protoAddr.unitNumber.length = 0;
					protoAddr.streetNumber.length = 0;
					protoAddr.streetNumberSuffix.length = 0;
					protoAddr.interpolations.length = 0;
					protoAddr.interpolationStart.length = 0;
					protoAddr.interpolationMul.length = 0;
					protoAddr.interpolationEnd.length = 0;
					for(let i = 0; i < addresses.length; i += 1){
						const address = addresses[i];
						protoAddr.item.push(address.id);
						protoAddr.itemType.push(address.type);
						protoAddr.itemName.push(address.name);
						protoAddr.unitNumber.push(address.unitNumber);
						protoAddr.streetNumber.push(address.streetNumber);
						protoAddr.streetNumberSuffix.push(address.streetNumberSuffix);
					}
					for(let i = 0; i < interpolations.length; i += 1){
						const interpolation = interpolations[i];
						protoAddr.interpolations.push(interpolation.id);
						protoAddr.interpolationStart.push(interpolation.start);
						protoAddr.interpolationMul.push(interpolation.mul);
						protoAddr.interpolationEnd.push(interpolation.end);
					}
					const [fuzzedChar, fuzzedNum] = phonetifyNum(protoAddr.streetPhoneticName, subdivLang, true, false);
					protoAddr[sStreetGroupIndex] = fuzzedChar.charCodeAt(0);
					protoAddr[sStreetIndexNum] = fuzzedNum;
					const firstAddress = addresses[0];
					const firstInterpolation = interpolations[0];
					if(firstAddress && firstInterpolation){
						protoAddr[sStreetMinNum] = Math.min(firstInterpolation.start, firstAddress.streetNumber);
					}else if(firstAddress){
						protoAddr[sStreetMinNum] = firstAddress.streetNumber;
					}else{
						protoAddr[sStreetMinNum] = firstInterpolation.start;
					}

					const lastAddress = addresses[addresses.length - 1];
					const lastInterpolation = interpolations[interpolations.length - 1];
					if(lastAddress && lastInterpolation){
						protoAddr[sStreetMaxNum] = Math.max(lastInterpolation.end, lastAddress.streetNumber);
					}else if(lastAddress){
						protoAddr[sStreetMaxNum] = lastAddress.streetNumber;
					}else{
						protoAddr[sStreetMaxNum] = lastInterpolation.end;
					}
					streets.push(protoAddr);
				}
			}catch(ex){
				if(ex.code == "ENOENT"){
					subdivProcessed += 1;
					// Administrative boundary with literally no addresses mapped (like R7588068 at the time of writing)
					continue;
				}
				throw ex;
			}
			if(streets.length){
				streets.sort((a, b) => {
					let diffNum = a[sStreetGroupIndex] - b[sStreetGroupIndex];
					if(diffNum != 0){
						return diffNum;
					}
					diffNum = a[sStreetIndexNum] - b[sStreetIndexNum];
					if(diffNum != 0){
						return diffNum;
					}
					if(a.streetFullName < b.streetFullName){
						return -1;
					}
					if(a.streetFullName > b.streetFullName){
						return 1;
					}
					return 0;
				});
				/**@type {Array<import("../proto-defs").ProtoStreetGroup>} */
				const streetGroups = [{
					groupIndex: streets[0][sStreetGroupIndex],
					streetIndex: [streets[0][sStreetIndexNum]],
					streetMinNum: [streets[0][sStreetMinNum]],
					streetMaxNum: [streets[0][sStreetMaxNum]],
					streets: [streets[0]]
				}];
				let streetGroupIndex = 0;
				for(let i = 1; i < streets.length; i += 1){
					const street = streets[i];
					const streetGroup = streetGroups[streetGroupIndex];
					if(street[sStreetGroupIndex] != streetGroup.groupIndex){
						streetGroupIndex += 1;
						streetGroups.push({
							groupIndex: street[sStreetGroupIndex],
							streetIndex: [street[sStreetIndexNum]],
							streetMinNum: [street[sStreetMinNum]],
							streetMaxNum: [street[sStreetMaxNum]],
							streets: [street]
						});
						continue;
					}
					streetGroup.streetIndex.push(street[sStreetIndexNum]);
					streetGroup.streetMinNum.push(street[sStreetMinNum]);
					streetGroup.streetMaxNum.push(street[sStreetMaxNum]);
					streetGroup.streets.push(street);
				}
				const pbf = new Pbf();
				SubdivisionStreetsParser.write({streetGroups}, pbf);
				const pbfBuf = pbf.finish();
				subdiv.streetOffset = streetsOffset;
				subdiv.streetLength = pbfBuf.length;
				streetsOffset += pbfBuf.length;
				if(!tmpStreetsStream.write(pbfBuf)){
					await new Promise(resolve => tmpStreetsStream.once("drain", resolve));
				}
			}
			subdivProcessed += 1;
			logProgressMsg(
				"Street address indexing: " + subdivProcessed + "/" + flatProtoSubdivs.size + " (" +
				(subdivProcessed / flatProtoSubdivs.size * 100).toFixed(2) +
				"%)"
			);
		}
		const tmpFileClosePromise = new Promise(resolve => tmpStreetsStream.once("close", resolve));
		tmpStreetsStream.end();
		console.log("Street address indexing: " + subdivProcessed + "/" + flatProtoSubdivs.size + " (100%)");
		for(let i = 0; i < protoSubdivs.length; i += 1){
			const protoSubdiv = protoSubdivs[i];
			// subdiv code w/o country code, padded to 3 chars
			const subdivCode = this.getPrincipalCode(protoSubdiv.name).substring(3).padEnd(3);
			const sizeBuf = Buffer.allocUnsafe(4);
			const pbf = new Pbf();
			SubdivisionParser.write(protoSubdiv, pbf);
			const pbfBuf = pbf.finish();
			sizeBuf.writeUInt32LE(pbfBuf.length);
			fileStream.write(subdivCode);
			fileStream.write(sizeBuf);
			if(!fileStream.write(pbfBuf)){
				await new Promise(resolve => fileStream.once("drain", resolve));
			}
		}
		fileStream.write("   ");
		const fileClosePromise = new Promise(resolve => fileStream.once("close", resolve));
		await tmpFileClosePromise;
		fs.createReadStream(tmpStreetsPath).pipe(fileStream);
		await fileClosePromise;
	}
}
module.exports = {StreetAssembler};
