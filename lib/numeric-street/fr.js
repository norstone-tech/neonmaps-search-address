// This is spaghetti written by someone who barely (if at all) speaks french
const numNames = [
	"zéro",
	"un",
	"deux",
	"trois",
	"quatre",
	"cinq",
	"six",
	"sept",
	"huit",
	"neuf",
	"dix",
	"onze",
	"douze",
	"treize",
	"quatorze",
	"quinze",
	"seize",
	"dix-sept",
	"dix-huit",
	"dix-neuf"
];
const numNames10th = [
	"oh",
	"dix",
	"vingt",
	"trente",
	"quarante",
	"cinquante",
	"soixante",
	"soixante-et-dix",
	"quatre-vingt",
	"quatre-vingt-dix"
];
const numPlaces = [
	"zéro",
	"unième", // première
	"deuxième", // seconde
	"troisième",
	"quatrième",
	"cinquième",
	"sixième",
	"septième",
	"huitième",
	"neuvième",
	"dixième",
	"onzième",
	"douzième",
	"treizième",
	"quatorzième",
	"quinzième",
	"seizième",
	"dix-septième",
	"dix-huitième",
	"dix-neuvième",
	"vingtième"
];
numPlaces[30] = "trentième";
numPlaces[40] = "quarantième";
numPlaces[50] = "cinquantième";
numPlaces[60] = "soixantième";
numPlaces[70] = "soixante-dixième";
numPlaces[80] = "quatre-vingtième";
numPlaces[90] = "quatre-vingt-dixième ";

/**
 * @param {string} str
 * @returns {string}
 */
const numbersToNames = function(str){
	// This will handle in groups of 2 digits, e.g. "425" -> "four twenty-five" 1337 -> "thirteen thirty-seven"
	return str.replace(/([0-9]{1,4})(e)?/, (
		fullMatch,
		/**@type {string}*/ numStr,
		/**@type {string}*/ suffix
	) => {
		let result = "";
		if(numStr.endsWith("000")){
			result += numNames[numStr[0]];
			if(suffix){
				result += "millième";
			}else{
				result += "mille";
			}
			return result;
		}
		const firstPair = numStr.length <= 2 ? "" : (numStr.length == 3 ? numStr[0] : numStr.substring(0, 2));
		const lastPair = numStr.length <= 2 ? numStr : numStr.substr(numStr.length - 2, 2);
		if(firstPair){
			const firstPairNum = Number(firstPair);
			if(numNames[firstPairNum]){
				result += numNames[firstPairNum];
			}else{
				result += numNames10th[firstPair[0]];
				if(result.endsWith("-dix")){
					const firstPairNum = Number(firstPair[1]) * 10;
					result = result.substring(0, result.length - 3) + numNames[firstPairNum];
				}else if(firstPair[1] != "0"){
					result += "-" + numNames[firstPair[1]];
				}
			}
			result += "-";
		}
		if(lastPair == "00"){
			if(suffix){
				result += "centième";
			}else{
				result += "cents";
			}
			return result;
		}else if(lastPair[0] == "0"){
			result += "et-"
		}
		const lastNumberPhrase = suffix ? numPlaces : numNames;
		const lastPairNum = Number(lastPair);
		if(lastNumberPhrase[lastPairNum]){
			if(suffix && !firstPair){
				switch(lastPairNum){
					case 1:
						result += "première";
						break;
					case 2:
						result += "seconde";
						break;
					default:
						result += lastNumberPhrase[lastPairNum];
				}
			}else{
				result += lastNumberPhrase[lastPairNum];
			}
		}else{
			result += numNames10th[lastPair[0]];
			if(result.endsWith("-dix")){
				const lastPairNum = Number(lastPair[1]) + 10;
				result = result.substring(0, result.length - 3) + lastNumberPhrase[lastPairNum];
			}else if(lastPair[1] != "0"){
				result += "-" + lastNumberPhrase[lastPair[1]];
			}
		}
		return result;
	});
}
module.exports = {numbersToNames};
