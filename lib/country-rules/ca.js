/* Full street address parser: /^(?:([0-9A-Z]*?)\s*-\s*)?([0-9]+)\s*(?:\(?(\.[0-9]+|[A-Z]|[0-9]+\/[0-9]+)\)?)?\s+(.*)$/i
   https://www.canada.ca/en/revenue-agency/services/e-services/e-services-individuals/account-individuals/contact-us/mailing-country-c3/civic-street-number-d6.html
   https://www.canadapost-postescanada.ca/tools/pg/manual/PGaddress-e.asp#1417752 */ 
module.exports = {
	houseNumberParser: /^([0-9]+)(?:\s*-?\s*\(?(\.[0-9]+|[A-Z]|[0-9]+\/[0-9]+)\)?)?$/i, // 1337, 1337A, 1337(A), 1337 (1/2), 1337 1/2, etc.
	houseNumberArrangement: [1, 2], // [civic street number, suffix]
	streetAddressParser: /^(?:([0-9A-Z]*?)\s*-\s*)?([0-9]+)\s*(?:\(?(\.[0-9]+|[A-Z]|[0-9]+\/[0-9]+)\)?)?\s+(.*)$/,
	streetAddressArrangement: [1, 2, 3, 4], // [unit number, street number, street number suffix, street name]
	// TODO: boundary whitelist regex, some countries have nested subdivisions defined in ISO 3166-2
	boundaryRules: {
		// Perhaps I should use "place" tags instead of using admin levels
		default: {
			cityAdminLevels: [6, 8],
			defaultLang: "en"
		},
		"CA-QC": {
			defaultLang: "fr"
		},
		"CA-BC": {
			cityAdminLevels: [8]
		}
	}
}