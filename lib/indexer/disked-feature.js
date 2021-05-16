// This entire thing is a big hack so I won't have to change what I already have so far
const fs = require("fs");
const path = require("path");
const turf = require("@turf/helpers");
const sFilePath = Symbol("featureFilePath");
const sBBox = Symbol("bbox");
const sGeometry = Symbol("geometry");
const sID = Symbol("id");
const sProperties = Symbol("properties");
const sInMem = Symbol("inMemory");
let MAX_CACHE_SIZE = 50;
const cache = [];

const cleanCache = function(){
	while(cache.length > MAX_CACHE_SIZE){
		const obj = cache.shift();
		/**@type {string} */
		const filePath = obj[sFilePath];
		obj[sInMem] = false;
		// TODO: Perhaps use package/synchronized-promise so multiple things can be written at once?
		fs.writeFileSync(filePath, JSON.stringify({
			bbox: obj[sBBox],
			geometry: obj[sGeometry],
			id: obj[sID],
			properties: obj[sProperties]
		}));
		delete obj[sBBox];
		delete obj[sGeometry];
		delete obj[sID];
		delete obj[sProperties];
	}
}
const readDiskFeat = function(obj){
	/**@type {string} */
	const filePath = obj[sFilePath];
	/**@type {turf.Feature} */
	const feat = JSON.parse(fs.readFileSync(filePath, "utf8"));
	obj[sInMem] = true;
	obj[sBBox] = feat.bbox;
	obj[sGeometry] = feat.geometry;
	obj[sID] = feat.id;
	obj[sProperties] = feat.properties;
	cache.push(obj);
	cleanCache();
}

// Defining it here instead of inline, otherwise there might be a memory "leak"
const getterFunc = function(obj, actualKey){
	if(!obj[sInMem]){
		readDiskFeat(obj);
	}else{
		cache.push(...cache.splice(cache.indexOf(obj)));
	}
	return obj[actualKey];
}
const setterFunc = function(obj, actualKey, value){
	if(!obj[sInMem]){
		readDiskFeat(obj);
	}
	obj[actualKey] = value;
}

/**
 * @param {turf.Feature} geoFeat 
 * @param {string} folder
 * @returns {turf.Feature}
 */
const createDiskedFeature = function(geoFeat, folder){
	if(geoFeat == null){
		return null;
	}
	if(geoFeat.type !== "Feature"){
		throw new Error("Must be feature");
	}
	/**@type {turf.Feature} */
	const newFeat = {
		type: geoFeat.type,
		[sFilePath]: path.resolve(folder, process.hrtime.bigint().toString(36) + ".json"),
		[sInMem]: true,
		[sBBox]: geoFeat.bbox,
		[sGeometry]: geoFeat.geometry,
		[sID]: geoFeat.id,
		[sProperties]: geoFeat.properties
	};
	Object.defineProperty(newFeat, "bbox", {
		enumerable: true,
		get: getterFunc.bind(this, newFeat, sBBox),
		set: setterFunc.bind(this, newFeat, sBBox)
	});
	Object.defineProperty(newFeat, "geometry", {
		enumerable: true,
		get: getterFunc.bind(this, newFeat, sGeometry),
		set: setterFunc.bind(this, newFeat, sGeometry)
	});
	Object.defineProperty(newFeat, "id", {
		enumerable: true,
		get: getterFunc.bind(this, newFeat, sID),
		set: setterFunc.bind(this, newFeat, sID)
	});
	Object.defineProperty(newFeat, "properties", {
		enumerable: true,
		get: getterFunc.bind(this, newFeat, sProperties),
		set: setterFunc.bind(this, newFeat, sProperties)
	});
	cache.push(newFeat);
	cleanCache();
	return newFeat;
}
const setDiskedFeatureCacheSize = function(num){
	MAX_CACHE_SIZE = num;
}
module.exports = {
	createDiskedFeature,
	setDiskedFeatureCacheSize
}