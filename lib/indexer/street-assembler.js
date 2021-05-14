const path = require("path");
const {promises: fsp} = require("fs");
const turf = require("@turf/helpers");
const {MapReader} = require("neonmaps-base");
const {default: geoCentroid} = require("@turf/centroid");
const {default: geoDistance} = require("@turf/distance");
const {geoContainsMultiPolygon, logProgressMsg} = require("../util");
const Pbf = require("pbf");
const {StreetAddresses: StreetAddressParser} = require("../proto-defs");
const {
	sCentroid,
	sDistance,
	sSubDivision
} = require("./symbols");
const enumElemType = {
	node: 0,
	way: 1,
	relation: 2
};
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
		this.subDivisions = subDivisions;
		this.maxCacheAmount = cacheAmount;
		/**@type {Map<string, import("../proto-defs").ProtoStreetAddresses>} */
		this.cache = new Map();
		const mapName = mapPath.substring(mapPath.lastIndexOf(path.sep) + 1, mapPath.length - ".osm.pbf".length);
		this.finalFilePath = path.resolve(mapPath, "..", mapName + ".neonmaps.addresses");
	}
	/**
	 * 
	 * @param {string} subdivPath 
	 * @returns {import("../proto-defs").ProtoStreetAddresses>}
	 */
	async getStreetData(subdivPath){
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
			unitNumber: [],
			streetNumber: [],
			streetNumberSuffix: [],
			interpolations: [],
			interpolationStart: [],
			interpolationEnd: []
		};
		this.cache.set(subdivPath, result);
		await this.cleanCache();
		return result;
	}
	async saveStreetData(subdivPath){
		const data = this.cache.get(subdivPath);
		const fullPath = path.resolve(this.dir, subdivPath + ".pbf");
		await fsp.mkdir(path.resolve(fullPath, ".."), {recursive: true});
		const pbf = new Pbf();
		StreetAddressParser.write(data, pbf);
		const pbfBuf = pbf.finish();
		this.cache.delete(subdivPath);
		await fsp.writeFile(fullPath, pbfBuf);
	}
	async cleanCache(){
		while (this.cache.size > this.maxCacheAmount){
			await this.saveStreetData(this.cache.keys().next().value);
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
			if(geoContainsMultiPolygon(subdiv, place)){
				if(subdiv[sSubDivision]){
					return this._actuallyGetSubdiv(
						subdiv[sSubDivision],
						place,
						curpath + subdiv.properties.name.replace(/\/\\\?\>\<\:\*\|"/, "_") + "/"
					);
				}
				return [subdiv, curpath + subdiv.properties.name];
			}
		}
		return [null, ""];
	}
	/**
	 * @param {turf.Feature} place
	 * @returns {[string, turf.Feature<turf.Polygon | turf.MultiPolygon>, string]}
	 */
	getSubdiv(place){
		const [subdiv, subdivPath] = this._actuallyGetSubdiv(this.subDivisions, place, "");
		const principalName = subdivPath.substring(0, subdivPath.indexOf(path.sep)) || subdivPath;
		for(let i = 0; i < this.subDivisions.length; i += 1){
			if(this.subDivisions[i].properties.name == principalName){
				return [this.subDivisions[i].properties["ISO3166-2"], subdiv, subdivPath];
			}
		}
		return ["", null, ""];
	}
	async doTheThing(){
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
						console.error("WARNING: TODO: addr:interpolation=alphabetic");
						continue;
					}
					const firstNode = await this.mapReader.getNode(place.nodes[i]);
					if(!firstNode.tags.has("addr:housenumber") || !firstNode.tags.has("addr:street")){
						console.error(
							"WARNING: First node defined in interpolation way " + place.id +
							" doesn't have an address defined!"
						);
						continue;
					}
					const firstNodeGeo = await this.mapReader.getNodeGeoJSON(firstNode);
					firstNodeGeo[sCentroid] = firstNodeGeo;
					const [principalSubdivCode, subdiv, subdivPath] = this.getSubdiv(firstNodeGeo);
					if(!principalSubdivCode){
						console.error("WARNING: unable to get subdivision for way " + place.id);
						continue;
					}
					const interpolationNum = isNaN(interpolation) ? 2 : Number(interpolation);
					let minValue = Infinity;
					let maxValue = -Infinity;
					for(let ii = 0; ii < place.nodes.length; ii += 1){
						const node = await this.mapReader.getNode(place.nodes[ii]);
						if(!node.tags.has("addr:housenumber")){
							continue;
						}
						const houseNumParts = place.tags.get("addr:housenumber").match(this.countryRules.houseNumberParser);
						if(houseNumParts == null){
							console.error(
								"WARNING: Unable to parse address \"" + place.tags.get("addr:housenumber") +
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
					const fullStreetName = firstNode.tags.get("addr:street");
					const streetPath = subdivPath + path.sep + fullStreetName;
					const streetData = await this.getStreetData(streetPath);
					streetData.interpolationStart.push(minValue);
					streetData.interpolationMul.push(interpolationNum);
					streetData.interpolationEnd.push(maxValue);
					continue;
				}
				if(!place.tags.has("addr:housenumber") || !place.tags.has("addr:street")){
					continue;
				}
				if(place.tags.has("addr:flats")){
					console.error("WARNING: TODO: addr:flats -> unit number interpolation");
				}
				const houseNumParts = place.tags.get("addr:housenumber").match(this.countryRules.houseNumberParser);
				if(houseNumParts == null){
					console.error(
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
					console.error("WARNING: " + place.type + " " + place.id + " has no (valid) geometry!");
					continue;
				}
				if(place.type == "node"){
					placeGeometry[sCentroid] = placeGeometry;
				}else{
					placeGeometry[sCentroid] = geoCentroid(placeGeometry);
				}
				const [principalSubdivCode, subdiv, subdivPath] = this.getSubdiv(placeGeometry);
				if(!principalSubdivCode){
					console.error("WARNING: unable to get subdivision for " + place.type + " " + place.id);
					continue;
				}
				const houseUnit = place.tags.has("addr:unit") ? place.tags.get("addr:unit") : "";
				const houseNumber = Number(houseNumParts[this.countryRules.houseNumberArrangement[0]]);
				const houseNumberSuffix = houseNumParts[this.countryRules.houseNumberArrangement[1]] ?? "";
				const fullStreetName = place.tags.get("addr:street");
				const streetPath = subdivPath + path.sep + fullStreetName;

				const streetData = await this.getStreetData(streetPath);
				if(!streetData.streetName){
					streetData.streetFullName = fullStreetName;
					streetData.streetDirection = streetDirection == -1 ? null : streetDirection;
				}
				streetData.unitNumber.push(houseUnit);
				streetData.streetNumber.push(houseNumber);
				streetData.streetNumberSuffix.push(houseNumberSuffix);
				streetData.item.push(place.id);
				streetData.itemType.push(enumElemType[place.type])
			}
			fileOffset += rawData._byte_size;
			logProgressMsg(
				"Street address indexing: " + fileOffset + "/" + mapSize + " (" +
				(fileOffset / mapSize * 100).toFixed(2) +
				"%)"
			);
		}
		while(this.cache.size > 0){
			await this.saveStreetData(this.cache.keys().next().value);
		}
		console.log("Street address indexing: " + fileOffset + "/" + mapSize + " (100%)");
	}
}
module.exports = {StreetAssembler};
