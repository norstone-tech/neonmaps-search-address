/* Full street address parser: /^(?:([0-9A-Z]??)-)?([0-9]+)\s*(?:\(?([A-Z]|[0-9]+\/[0-9]+)\)?)?\s+(.*)$/i
   https://www.canada.ca/en/revenue-agency/services/e-services/e-services-individuals/account-individuals/contact-us/mailing-country-c3/civic-street-number-d6.html
   https://www.canadapost-postescanada.ca/tools/pg/manual/PGaddress-e.asp#1417752
   NOTE: It may be better to expand street abbreviations during searches, ex: "rd" -> "road" instead of categorizing,
         then specifying prefixes to ignore in the case of french
   them */ 
module.exports = {
	houseNumberParser: /^([0-9]+)(?:\s*-?\s*\(?([A-Z]|[0-9]+\/[0-9]+)\)?)?$/i, // 1337, 1337A, 1337(A), 1337 (1/2), 1337 1/2, etc.
	houseNumberArrangement: [1, 2], // [civic street number, suffix]
	streetTypeLinguisticSugar: [
		// $1 == streetType, $2 == street name
		"$1 de la $2",
		"$1 du la $2",
		"$1 de $2",
		"$1 du $2",
		"$1 des $2",
		"$1 d'$2"
	],
	// The regexes defined here, if tested, are allowed to 
	streetTypeWhitelist: [
		/road [0-9]+/i,
		/highway [0-9]+/i,
		/queensway/i, // "the queensway", "queensway east" in toronto
		/kingsway/i,
		/manor$/i,
		/fernway$/i
	],
	streetTypeDirections: [
		["east", "est", "e"],
		["south", "sud", "s"],
		["west", "ouest", "w", "o"],
		["north", "nord", "n"]
	],
	streetTypes: [
		// French types are appended on the english
		["alley", "allee", "ally", "aly", "allée"],
		["annex", "anex", "annx", "anx", "annexe"],
		["arcade", "arc"],
		["avenue", "av", "ave", "aven", "avenu", "avn", "avnue"],
		["boulevard", "boul", "boulv", "blvd"],
		["branch", "brnch", "br", "branche"],
		["bridge", "brdge", "brg", "pont"],
		["circuit", "cr"],
		["circle", "circ", "circl", "crcl", "crcle", "cir", "cercle", "cer"],
		["close", "cls"], // How rare is this?!
		["court", "ct"],
		["crescent", "crsent", "crsnt", "cres", "croissant", "crois", "cro"],
		["downs"],
		["drive", "driv", "drv", "dr", "route", "rt"],
		["field", "fld", "domaine", "dom"],
		["garden", "gardn", "grden", "grdn", "gdn"],
		["gardens", "gdns"],
		["gate"],
		["glen", "glenn", "gln"],
		["green", "grn"],
		["grove", "grov", "grv"],
		["heights", "hts"],
		["highway", "highwy", "hiway", "hiwy", "hway", "hwy", "autoroute", "aut"],
		// "montée" may not belong here
		["hill", "hl", "montée", "montee", "mont", "mont"],
		["hills", "hls"],
		["lane", "ln"],
		["line"], // also abbreviated as "ln" but w/e
		["keep"], // How rare is this?!?!
		["mews"], // For fucks sake, "mews"
		["park", "prk"],
		["parkway", "parkwy", "pkway", "pky", "pkwy", "promenade", "prom"],
		["path", "pth"],
		["pathway", "pthwy"],
		["place", "pl"],
		["point", "pt"],
		["private", "prvt", "pvt", "impasse", "imp", "im"],
		["quay", "qy"], // I think this is exclusively used in toronto
		["ridge", "rdge", "rdg"],
		["road", "rd", "rue"],
		["row", "rw"],
		["square", "sqr", "sqre", "squ", "sq", "carré", "carre", "car"],
		["street", "str", "strt", "st", "chemin", "ch"],
		["terrace", "terr", "ter"],
		["trail", "trl"],
		["walk"],
		["way", "wy", "voie", "vo"],
		/* Not really a street type so it's at the end, but a lot of things are simply marked "the (name)" and I want
		   just (name) to be searchable */
		["the"],
		// These appear to be french-only (Or i don't know the translation)
		["côte", "cot", "cote"],
		["cours", "cou"],
		["rang", "ran", "rn"],
		["ruelle"],
		["sentier", "sen"],
		["passage", "pass", "pas"]
	],
	boundaryRules: {
		// Perhaps I should use "place" tags instead of using admin levels
		default: {
			cityAdminLevels: [6, 8],
			numericStreetLang: "en",
			// Street type can still be before, "Highway 123", "Avenue Q" (Yes, that's a thing that exists in Ottawa)
			streetTypePlacement: ["after", "before"],
		},
		"CA-QC": {
			numericStreetLang: "fr",
			// Street type can still be after, (14e, 15e, etc.)
			streetTypePlacement: ["before", "after"]
		},
		"CA-BC": {
			cityAdminLevels: [8]
		}
	}
}