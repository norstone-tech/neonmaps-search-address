// This is spaghetti, but at least it works for now
const numNames = [
	"zero",
	"one",
	"two",
	"three",
	"four",
	"five",
	"six",
	"seven",
	"eight",
	"nine",
	"ten",
	"eleven",
	"twelve",
	"thirteen",
	"fourteen",
	"fifteen",
	"sixteen",
	"seventeen",
	"eighteen",
	"nineteen"
];
const numNames10th = [
	"oh",
	"teen",
	"twenty",
	"thirty",
	"fourty",
	"fifty",
	"sixty",
	"seventy",
	"eighty",
	"ninety"
];
const numPlaces = [
	"zeroth",
	"first",
	"second",
	"third",
	"fourth",
	"fifth",
	"sixth",
	"seventh",
	"eighth",
	"ninth",
	"tenth",
	"eleventh",
	"twelfth",
	"thirteenth",
	"fourteenth",
	"fifteenth",
	"sixteenth",
	"seventeenth",
	"eighteenth",
	"nineteenth",
	"twentieth"
];
numPlaces[30] = "thirtieth";
numPlaces[40] = "fortieth";
numPlaces[50] = "fiftieth";
numPlaces[60] = "sixtieth";
numPlaces[70] = "seventieth";
numPlaces[80] = "eightieth";
numPlaces[90] = "ninetieth";

/**
 * @param {string} str
 * @returns {string}
 */
const numbersToNames = function(str){
	// This will handle in groups of 2 digits, e.g. "425" -> "four twenty-five" 1337 -> "thirteen thirty-seven"
	return str.replace(/([0-9]{1,4})(st|nd|rd|th)?/, (
		fullMatch,
		/**@type {string}*/ numStr,
		/**@type {string}*/ suffix
	) => {
		let result = "";
		if(numStr.endsWith("000")){
			result += numNames[numStr[0]];
			if(suffix){
				result += "-thousandth";
			}else{
				result += "-thousand";
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
				if(firstPair[1] != "0"){
					result += "-" + numNames[firstPair[1]];
				}
			}
			result += "-";
		}
		if(lastPair == "00"){
			if(suffix){
				result += "hundredth";
			}else{
				result += "hundred";
			}
			return result;
		}else if(lastPair[0] == "0"){
			result += "oh-"
		}
		const lastNumberPhrase = suffix ? numPlaces : numNames;
		const lastPairNum = Number(lastPair);
		if(lastNumberPhrase[lastPairNum]){
			result += lastNumberPhrase[lastPairNum];
		}else{
			result += numNames10th[lastPair[0]];
			if(lastPair[1] != "0"){
				result += "-" + lastNumberPhrase[lastPair[1]];
			}
		}
		return result;
	});
}
module.exports = {numbersToNames};
