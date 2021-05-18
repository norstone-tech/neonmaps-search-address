const fs = require("fs");
const protoCompile = require('pbf/compile');
const parseProtoSchema = require('protocol-buffers-schema');
const path = require("path");
/**
 * @typedef ProtoStreetAddresses
 * @property {string} streetFullName
 * @property {string} streetPhoneticName
 * @property {Array<number>} item
 * @property {Array<number>} itemType
 * @property {Array<string>} itemName
 * @property {Array<string>} unitNumber
 * @property {Array<number>} streetNumber
 * @property {Array<string>} streetNumberSuffix
 * @property {Array<number>} interpolations
 * @property {Array<number>} interpolationStart
 * @property {Array<number>} interpolationMul
 * @property {Array<number>} interpolationEnd
 */
/**
 * @typedef ProtoStreetGroup
 * @property {number} groupIndex
 * @property {Array<number>} streetIndex
 * @property {Array<number>} streetMinNum
 * @property {Array<number>} streetMaxNum
 * @property {Array<ProtoStreetAddresses>} streets
 */
/**
 * @typedef ProtoSubdivisionStreets
 * @property {Array<ProtoStreetGroup>} streetGroups
 */
/**
 * @typedef ProtoSubdivision
 * @property {string} name
 * @property {number} osmID
 * @property {number} osmType
 * @property {number} lat
 * @property {number} lon
 * @property {Array<number>} streetOffset
 * @property {Array<number>} streetLength
 * @property {Array<ProtoSubdivision>} subdivision
 */
const {
	StreetAddresses,
	Subdivision,
	SubdivisionStreets
} = protoCompile(
	parseProtoSchema(fs.readFileSync(path.resolve(__dirname, "neonmaps-address.proto")))
);
module.exports = {
	StreetAddresses,
	Subdivision,
	SubdivisionStreets
};
