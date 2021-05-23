const {refined: soundexRefined} = require("talisman/phonetics/soundex");
// const strDist = require("talisman/metrics/damerau-levenshtein");
const langOptions = new Map([
	["fr", require("./fr")],
	["en", require("./en")]
]);
/**@typedef {"en" | "fr"} LanguageString */
/**
 * 
 * @param {string} str 
 * @param {LanguageString} language 
 */
const removePrefix = function(str, language){
	const {
		streetAbbreviations,
		directionAbbreviations,
		ignoredPrefixes,
		ignoredPrefixSuffixes
	} = langOptions.get(language);
	const firstSpace = str.indexOf(" ");
	if(firstSpace >= 0){
		let firstWord = str.substring(0, str.indexOf(" "));
		firstWord = streetAbbreviations.get(firstWord) || directionAbbreviations.get(firstWord) || firstWord;
		str = firstWord + str.substring(firstSpace);
	}
	let strPrefix = "";
	for(const prefix of ignoredPrefixes.values()){
		if(str.startsWith(prefix + " ")){
			strPrefix += prefix;
			str = str.substring(prefix.length);
			str = str.trim();
			for(const prefixSuffix of ignoredPrefixSuffixes.values()){
				if(str.startsWith(prefixSuffix)){
					strPrefix += prefixSuffix;
					str = str.substring(prefixSuffix.length);
					break;
				}
			}
			str = str.trim();
			if(!strPrefix.endsWith("'") && !strPrefix.endsWith(" ")){
				strPrefix += " ";
			}
			break;
		}
	}
	return [str, strPrefix];
}

/**
 * @param {string} str 
 * @param {LanguageString} language
 * @param {boolean} [rmPrefix=false]
 * @returns {string}
 */
const expand = function(str, language, rmPrefix){
	const {
		ampersand,
		numbersToNames,
		nameAbbreviations,
		streetAbbreviations,
		directionAbbreviations
	} = langOptions.get(language);
	str = numbersToNames(str.toLowerCase().replace(/\s*&\s*/g, " " + ampersand + " ").trim());
	let strPrefix;
	[str, strPrefix] = removePrefix(str, language);
	const strs = str.split(" ");
	let abbStr = strs[0];
	if(abbStr.endsWith(".")){
		abbStr = abbStr.substring(0, abbStr.length - 1);
	}
	strs[0] = nameAbbreviations.get(abbStr) ||
		streetAbbreviations.get(abbStr) ||
		directionAbbreviations.get(abbStr) ||
		abbStr;
	for(let i = 1; i < strs.length; i += 1){
		abbStr = strs[i];
		if(abbStr.endsWith(".")){
			abbStr = abbStr.substring(0, abbStr.length - 1);
		}
		strs[i] = streetAbbreviations.get(abbStr) ||
			directionAbbreviations.get(abbStr) ||
			abbStr;
	}
	str = strs.join(" ");
	return rmPrefix ? str : (strPrefix + str);
}
/**
 * @param {string} str 
 * @param {LanguageString} language 
 * @param {boolean} [expanded=false]
 * @param {boolean} [prefixRemoved=true]
 * @returns {string}
 */
const phonetify = function(str, language, expanded, prefixRemoved = true){
	if(!expanded){
		str = expand(str, language, true);
	}else if(!prefixRemoved){
		[str] = removePrefix(str, language);
	}
	/* Sticking my own modifications on top of refined-soundex. This is because phonex didn't work that well for
	   auto-completion. "pine trail" wasn't a substring of "pain trail cres", as the "C" sound overpowered the "L"
	   sound. The result of this functionshare similar characteristics of both phonex and soundex */
	str = soundexRefined(
		str.replace(/($|\s*)kn/g, (fullMatch, space) => space + "n")
			.replace(/($|\s*)wr/g, (fullMatch, space) => space + "r")
			.replace(/ph/g, "f")
			.replace(/x/g, "ks") // Who in the right mind thinks "x", "q", and "z" sound alike?!
			.replace(/q/g, "k")
			.replace(/z/g, "s")
			.replace(/s+$/, "")
	);
	// Removed the first fuzzed char, it is redundant
	switch (str[0]){
		case "E":
		case "I":
		case "O":
		case "U":
			str = "A" + str.substring(2);
			break;
		case "K":
			str = "C" + str.substring(2);
			break;
		case "J":
			str = "G" + str.substring(2);
			break;
		default:
			str = str[0] + str.substring(2);
	}
	return str.replace(/0/g, ""); // Remove vowels to save space
}
/**
 * @param {string} str 
 * @param {LanguageString} language 
 * @param {boolean} [expanded=false]
 * @param {boolean} [prefixRemoved=true]
 * @returns {[string, number]}
 */
const phonetifyNum = function(str, language, expanded, prefixRemoved = false){
	const fuzzedStr = phonetify(str, language, expanded, prefixRemoved);
	let fuzzedNum = fuzzedStr.substring(1);
	if(fuzzedNum.length > 15){
		// (Number.MAX_SAFE_INTEGER + "").length == 16
		// r = 9, so... 15
		fuzzedNum = fuzzedNum.substring(0, 15);
	}else{
		fuzzedNum += "0".repeat(15 - fuzzedNum.length);
	}
	return [fuzzedStr[0], Number(fuzzedNum)];
}
module.exports = {expand, phonetify, phonetifyNum, removePrefix};
