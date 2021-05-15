const turf = require("@turf/helpers");
const {default: geoContains} = require("@turf/boolean-contains");
let nextProgressMsg = Date.now();
const logProgressMsg = function(...msg){
	if(nextProgressMsg <= Date.now()){
		console.log(...msg);
		nextProgressMsg = Date.now() + 300;
	}
};

// This function implemented in @turf/boolean-contains for some reason, and enclaves/exclaves are a thing
const geoContainsMultiPolygon = function(
	/**@type {turf.Feature<turf.MultiPolygon | turf.Polygon>} */ poly1,
	/**@type {turf.Feature<turf.MultiPolygon | turf.Polygon | turf.LineString | turf.Point>} */ poly2
){
	/**@type {Array<turf.Feature<turf.Polygon>>} */
	const polys1 = poly1.geometry.type != "MultiPolygon" ? [poly1] : poly1.geometry.coordinates.map(v => turf.polygon(v));
	/**@type {Array<turf.Feature<turf.Polygon | turf.LineString | turf.Point>>} */
	const polys2 = poly2.geometry.type != "MultiPolygon" ? [poly2] : poly2.geometry.coordinates.map(v => turf.polygon(v));
	
	// all poly2's polys must be completely within one of poly1's polys
	let polys2InPolys1 = true;
	for(let i = 0; i < polys2.length; i += 1){
		let inPoly1 = false;
		for(let ii = 0; ii < polys1.length; ii += 1){
			if(geoContains(polys1[ii], polys2[i])){
				inPoly1 = true;
				break;
			}
		}
		polys2InPolys1 = polys2InPolys1 && inPoly1;
		if(!polys2InPolys1){
			break;
		}
	}
	return polys2InPolys1;
}
module.exports = {geoContainsMultiPolygon, logProgressMsg};
