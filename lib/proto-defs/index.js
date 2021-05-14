const fs = require("fs");
const protoCompile = require('pbf/compile');
const parseProtoSchema = require('protocol-buffers-schema');
const path = require("path");
/**
 * @typedef ProtoStreetAddresses
 * @property {string} streetFullName
 * @property {Array<number>} item
 * @property {Array<number>} itemType
 * @property {Array<string>} unitNumber
 * @property {Array<number>} streetNumber
 * @property {Array<string>} streetNumberSuffix
 * @property {Array<number>} interpolations
 * @property {Array<number>} interpolationStart
 * @property {Array<number>} interpolationMul
 * @property {Array<number>} interpolationEnd
 */
const {
	StreetAddresses
} = protoCompile(
	parseProtoSchema(fs.readFileSync(path.resolve(__dirname, "neonmaps-address.proto")))
);
module.exports = {
	StreetAddresses
};
