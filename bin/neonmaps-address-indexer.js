const os = require("os");
const path = require("path");
const fs = require("fs");
const {promises: fsp} = require("fs");
const crypto = require("crypto");
const {MapReader} = require("neonmaps-base");
const {program} = require('commander');
const turf = require("@turf/helpers");
const {default: geoCentroid} = require("@turf/centroid");
const {default: geoDistance} = require("@turf/distance");
const {default: geoBBox} = require("@turf/bbox");
const {geoContainsMultiPolygon, logProgressMsg} = require("../lib/util");
const {createDiskedFeature} = require("../lib/indexer/disked-feature");
const {StreetAssembler} = require("../lib/indexer/street-assembler");
const INT48_SIZE = 6;
const options = program
	.requiredOption("-m, --map <path>", "Map file, in .osm.pbf format")
	.requiredOption("-c, --country <code>", "ISO 3166 country code")
	.option("-ph2, --phase2 <dir>", "(debug) dir to start phase 2 in")
	.parse()
	.opts();
const mapPath = path.resolve(options.map);
const mapReader = new MapReader(mapPath, 5, 5, 0, 10, 5, true, false);

const {
	sCentroid,
	sDistance,
	sOSMID,
	sOSMType,
	sSubDivision,
	sUnsortedSubDivision
} = require("../lib/indexer/symbols");
;
(async () => {
	try{
		const country = (options.country + "").toUpperCase();
		if(country !== "CA"){
			/* This indexer may be able to be used in the USA, too. But testing is only being done in canada at the
			   time of writing */
			throw new Error("Only Canada is supported at this time");
		}
		const tmpDir = options.phase2 ? path.resolve(options.phase2) : await fsp.mkdtemp(path.join(os.tmpdir(), "neonmaps-address-"));
		await mapReader.init();
		const {size: mapSize} = await fsp.stat(mapPath);
		const mapHeader = await mapReader.readMapSegment(0);
		const offsetNodeStart = mapHeader._byte_size;
		const offsetWayStart = (await mapReader.elemIndex.wayIndex.item(0)).readUIntLE(INT48_SIZE, INT48_SIZE);
		const offsetRelationStart = (await mapReader.elemIndex.relationIndex.item(0)).readUIntLE(INT48_SIZE, INT48_SIZE);
		let fileOffset = offsetWayStart;
		let fileOffsetStart = offsetWayStart;
		/**@type {import("neonmaps-base/lib/map-reader-base").OSMRelation} */
		let countryData;
		const topCountrySubdivisons = [];
		while(fileOffset < mapSize){
			/**@type {import("neonmaps-base/lib/map-reader-base").OSMData} */
			const rawData = await mapReader.readMapSegment(fileOffset);
			const mapSegment = MapReader.decodeRawData(rawData);
			for(let i = 0; i < mapSegment.ways.length; i += 1){
				const way = mapSegment.ways[i];
				if(!way.tags.has("ISO3166-2") || !way.tags.get("ISO3166-2").startsWith(country)){
					continue;
				}
				const feat = createDiskedFeature(await mapReader.getWayGeoJSON(way), tmpDir);
				if(feat == null){
					console.error("WARNING: " + way.tags.get("name") + " has no geometry!");
					continue;
				}
				feat[sOSMType] = way.type;
				feat[sOSMID] = way.id;
				topCountrySubdivisons.push(feat);
			}
			for(let i = 0; i < mapSegment.relations.length; i += 1){
				const relation = mapSegment.relations[i];
				/*
				if(relation.tags.has("ISO3166-1") && relation.tags.get("ISO3166-1") == country){
					countryData = relation;
					continue;
				}
				*/
				if(!relation.tags.has("ISO3166-2") || !relation.tags.get("ISO3166-2").startsWith(country)){
					continue;
				}
				const feat = createDiskedFeature(await mapReader.getRelationGeoJSON(relation), tmpDir);
				if(feat == null){
					console.error("WARNING: " + relation.tags.get("name") + " has no (valid) geometry!");
					continue;
				}
				feat[sOSMType] = relation.type;
				feat[sOSMID] = relation.id;
				topCountrySubdivisons.push(feat);
			}
			fileOffset += rawData._byte_size;
			logProgressMsg(
				"Country subdivisons: " + (fileOffset - fileOffsetStart) + "/" + (mapSize - fileOffsetStart) + " (" +
				((fileOffset - fileOffsetStart) / (mapSize - fileOffsetStart) * 100).toFixed(2) +
				"%)"
			);
			
		}
		console.log("Country subdivisons: " + (fileOffset - fileOffsetStart) + "/" + (mapSize - fileOffsetStart) + " (100%)");
		for(let i = 0; i < topCountrySubdivisons.length; i += 1){
			const subdiv = topCountrySubdivisons[i];
			subdiv[sCentroid] = geoCentroid(subdiv);
			subdiv.bbox = geoBBox(subdiv);
		}
		const countryRules = require("../lib/country-rules/ca");
		fileOffsetStart = fileOffset = offsetWayStart;
		const validCityAdminLevel = new Set();
		for(const {cityAdminLevels} of Object.values(countryRules.boundaryRules)){
			if(cityAdminLevels != null){
				for(let i = 0; i < cityAdminLevels.length; i += 1){
					validCityAdminLevel.add(cityAdminLevels[i])
				}
			}
		}

		while(fileOffset < mapSize){
			/**@type {import("neonmaps-base/lib/map-reader-base").OSMData} */
			const rawData = await mapReader.readMapSegment(fileOffset);
			const mapSegment = MapReader.decodeRawData(rawData);
			const things = [...mapSegment.ways, ...mapSegment.relations];
			for(let i = 0; i < things.length; i += 1){
				const potentialCity = things[i];
				const adminLevel = Number(potentialCity.tags.get("admin_level"));
				if(
					!validCityAdminLevel.has(adminLevel) ||
					potentialCity.tags.get("type") != "boundary" ||
					(
						potentialCity.tags.get("boundary") != "administrative" &&
						potentialCity.tags.get("boundary") != "aboriginal_lands"
					)
				){
					continue;
				}
				const geoCity = createDiskedFeature(potentialCity.type == "way" ?
					await mapReader.getWayGeoJSON(potentialCity) :
					await mapReader.getRelationGeoJSON(potentialCity)
				, tmpDir);
				if(geoCity == null){
					console.error(
						"WARNING: " + potentialCity.type + " " + potentialCity.id +
						" (" + potentialCity.tags.get("name") + ") has no (valid) geometry!"
					);
					continue;
				}
				if(geoCity.geometry.type !== "Polygon" && geoCity.geometry.type !== "MultiPolygon"){
					// This should never happen
					continue;
				}
				const cityCentroid = geoCentroid(geoCity);
				geoCity[sCentroid] = cityCentroid;
				geoCity[sOSMType] = potentialCity.type;
				geoCity[sOSMID] = potentialCity.id;
				geoCity.bbox = geoBBox(geoCity);
				/* It's cheaper to first sort by distance because geoContains is very expensive. It's better if we
				   only have to use it once or twice instead of potentially the entire list */
				for(let ii = 0; ii < topCountrySubdivisons.length; ii += 1){
					const subdiv = topCountrySubdivisons[ii];
					subdiv[sDistance] = geoDistance(cityCentroid, subdiv[sCentroid]);
				}
				topCountrySubdivisons.sort((a, b) => a[sDistance] - b[sDistance]);
				for(let ii = 0; ii < topCountrySubdivisons.length; ii += 1){
					const subdiv = topCountrySubdivisons[ii];
					if(geoContainsMultiPolygon(subdiv, geoCity)){
						const subdivRules = Object.assign(
							Object.create(countryRules.boundaryRules.default),
							countryRules.boundaryRules[subdiv.properties["ISO3166-2"]] ?? {}
						);
						/**@type {number} */
						const cityAdminLevelIndex = subdivRules.cityAdminLevels.indexOf(adminLevel);
						if(cityAdminLevelIndex == -1){
							break;
						}
						if(subdiv[sUnsortedSubDivision] == null){
							subdiv[sUnsortedSubDivision] = [];
						}
						if(subdiv[sUnsortedSubDivision][cityAdminLevelIndex] == null){
							subdiv[sUnsortedSubDivision][cityAdminLevelIndex] = [];
						}
						subdiv[sUnsortedSubDivision][cityAdminLevelIndex].push(geoCity);
						break;
					}
				}
			}
			fileOffset += rawData._byte_size;
			logProgressMsg(
				"City search: " + (fileOffset - fileOffsetStart) + "/" + (mapSize - fileOffsetStart) + " (" +
				((fileOffset - fileOffsetStart) / (mapSize - fileOffsetStart) * 100).toFixed(2) +
				"%)"
			);
		}
		console.log("City search: " + (mapSize - fileOffsetStart) + "/" + (mapSize - fileOffsetStart) + " (100%)");
		let subDivisionCount = 0;
		let subDivisionsProcessed = 0;
		for(let i = 0; i < topCountrySubdivisons.length; i += 1){
			const topSubDiv = topCountrySubdivisons[i];
			/**@type {Array<Array<turf.Feature<turf.Polygon | turf.MultiPolygon>>>} */
			const unsortedSubDivs = topSubDiv[sUnsortedSubDivision];
			for(let ii = 0; ii < unsortedSubDivs.length; ii += 1){
				subDivisionCount += unsortedSubDivs[ii].length;
			}
		}
		for(let i = 0; i < topCountrySubdivisons.length; i += 1){
			const topSubDiv = topCountrySubdivisons[i];
			/**@type {Array<Array<turf.Feature<turf.Polygon | turf.MultiPolygon>>>} */
			const unsortedSubDivs = topSubDiv[sUnsortedSubDivision];

			/**@type {Array<turf.Feature<turf.MultiPolygon>>} */
			for(let ii = unsortedSubDivs.length - 1; ii > 0; ii -= 1){
				const outerSubdivs = unsortedSubDivs[ii - 1];
				const innerSubdivs = unsortedSubDivs[ii];
				for(let iii = 0; iii < innerSubdivs.length; iii += 1){
					const innerSubdiv = innerSubdivs[iii];
					/* As said before, it's cheaper to first sort by distance because geoContains is very expensive.
					   It's better if we only have to use it once or twice instead of potentially the entire list */
					for(let iv = 0; iv < outerSubdivs.length; iv += 1){
						const outerSubdiv = outerSubdivs[iv];
						outerSubdiv[sDistance] = geoDistance(outerSubdiv[sCentroid], innerSubdiv[sCentroid]);
					}
					outerSubdivs.sort((a, b) => a[sDistance] - b[sDistance]);
					for(let iv = 0; iv < outerSubdivs.length; iv += 1){
						const outerSubdiv = outerSubdivs[iv];
						if(geoContainsMultiPolygon(outerSubdiv, innerSubdiv)){
							if(outerSubdiv[sSubDivision] == null){
								outerSubdiv[sSubDivision] = [];
							}
							outerSubdiv[sSubDivision].push(innerSubdiv);
							innerSubdivs.splice(iii, 1);
							iii -= 1;
							break;
						}
					}
					subDivisionsProcessed += 1;
					logProgressMsg(
						"City subdivide: " + subDivisionsProcessed + "/" + subDivisionCount + " (" +
						(subDivisionsProcessed / subDivisionCount * 100).toFixed(2) +
						"%)"
					);
				}
				if(ii > 1){
					subDivisionCount += innerSubdivs.length;
				}
				for(let iii = 0; iii < innerSubdivs.length; iii += 1){
					// This "inner" subdivisions aren't contained by anything, shove it one level up
					outerSubdivs.push(innerSubdivs[iii]);
				}
			}
			topSubDiv[sSubDivision] = unsortedSubDivs[0] ?? [];
			subDivisionsProcessed += topSubDiv[sSubDivision].length;
		}
		console.log("City subdivide: " + (subDivisionCount) + "/" + (subDivisionCount) + " (100%)");
		const printTree = function(/**@type {turf.Feature<turf.MultiPolygon>} */ thing, depth = "    "){
			console.log(depth + thing.properties.name + " (" + thing.properties.place + ")");
			const subdivs = thing[sSubDivision];
			if(subdivs && subdivs.length){
				for(let i = 0; i < subdivs.length; i += 1){
					printTree(subdivs[i], depth + "    ");
				}
			}
		}
		for(let i = 0; i < topCountrySubdivisons.length; i += 1){
			printTree(topCountrySubdivisons[i]);
		}
		
		const streetAssembler = new StreetAssembler(tmpDir, mapReader, country, topCountrySubdivisons, 10);
		if(options.phase2){
			console.log("skipping street assembly phase 1")
		}else{
			await streetAssembler.indexPlaces();
		}
		
	}catch(ex){
		console.error(ex);
		process.exitCode = 1;
	}
	await mapReader.stop();
})();