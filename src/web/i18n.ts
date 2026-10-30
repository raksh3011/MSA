/**
 * Strings for the public Boundary Safety view (English, Hindi, Gujarati).
 * NOTE: Hindi/Gujarati text should be reviewed by native speakers before real-world use.
 */
export type Lang = 'en' | 'hi' | 'gu';

type Key =
  | 'title' | 'subtitle' | 'useLocation' | 'manual' | 'lat' | 'lon' | 'check'
  | 'safe' | 'caution' | 'danger' | 'crossed' | 'distance' | 'disclaimer'
  | 'locating' | 'denied' | 'unsupported' | 'invalid' | 'back' | 'updated';

const STR: Record<Lang, Record<Key, string>> = {
  en: {
    title: 'Boundary Safety Check',
    subtitle: 'Know how far you are from the maritime boundary. Works offline once loaded.',
    useLocation: 'Use my location',
    manual: 'Or enter position manually',
    lat: 'Latitude (N)',
    lon: 'Longitude (E)',
    check: 'Check',
    safe: 'SAFE - you are well inside Indian waters',
    caution: 'CAUTION - near the boundary. Consider turning back.',
    danger: 'DANGER - boundary very close. Turn back now.',
    crossed: 'BOUNDARY CROSSED - return to Indian waters immediately',
    distance: 'Distance to boundary',
    disclaimer: 'Approximate and illustrative. Do not rely on this for navigation. Follow official guidance.',
    locating: 'Finding your position...',
    denied: 'Location permission denied. Enter your position manually below.',
    unsupported: 'Location is not available on this device. Enter your position manually.',
    invalid: 'Enter a valid latitude (-90 to 90) and longitude (-180 to 180).',
    back: 'Back',
    updated: 'Last updated',
  },
  hi: {
    title: 'सीमा सुरक्षा जाँच',
    subtitle: 'जानें कि आप समुद्री सीमा से कितनी दूर हैं। एक बार खुलने के बाद बिना इंटरनेट भी चलता है।',
    useLocation: 'मेरी लोकेशन उपयोग करें',
    manual: 'या अपनी स्थिति हाथ से दर्ज करें',
    lat: 'अक्षांश (उत्तर)',
    lon: 'देशांतर (पूर्व)',
    check: 'जाँचें',
    safe: 'सुरक्षित - आप भारतीय जलक्षेत्र में काफ़ी अंदर हैं',
    caution: 'सावधान - सीमा के पास हैं। लौटने पर विचार करें।',
    danger: 'खतरा - सीमा बहुत पास है। अभी लौटें।',
    crossed: 'सीमा पार - तुरंत भारतीय जल की ओर लौटें',
    distance: 'सीमा से दूरी',
    disclaimer: 'यह अनुमानित और उदाहरण-मात्र है। नौवहन के लिए इस पर निर्भर न रहें। सरकारी निर्देशों का पालन करें।',
    locating: 'आपकी स्थिति खोजी जा रही है...',
    denied: 'लोकेशन की अनुमति नहीं मिली। नीचे अपनी स्थिति हाथ से दर्ज करें।',
    unsupported: 'इस डिवाइस पर लोकेशन उपलब्ध नहीं है। अपनी स्थिति हाथ से दर्ज करें।',
    invalid: 'सही अक्षांश (-90 से 90) और देशांतर (-180 से 180) दर्ज करें।',
    back: 'वापस',
    updated: 'अंतिम अपडेट',
  },
  gu: {
    title: 'સીમા સુરક્ષા તપાસ',
    subtitle: 'દરિયાઈ સીમાથી તમે કેટલા દૂર છો તે જાણો. એકવાર ખુલ્યા પછી ઇન્ટરનેટ વગર પણ ચાલે છે.',
    useLocation: 'મારું સ્થાન વાપરો',
    manual: 'અથવા સ્થાન જાતે દાખલ કરો',
    lat: 'અક્ષાંશ (ઉત્તર)',
    lon: 'રેખાંશ (પૂર્વ)',
    check: 'તપાસો',
    safe: 'સુરક્ષિત - તમે ભારતીય જળસીમામાં સારી રીતે અંદર છો',
    caution: 'સાવધાન - સીમા નજીક છો. પાછા ફરવાનું વિચારો.',
    danger: 'જોખમ - સીમા ખૂબ નજીક છે. હમણાં જ પાછા વળો.',
    crossed: 'સીમા પાર - તરત ભારતીય જળસીમા તરફ પાછા ફરો',
    distance: 'સીમાથી અંતર',
    disclaimer: 'આ અંદાજિત અને ઉદાહરણરૂપ છે. નેવિગેશન માટે તેના પર આધાર ન રાખો. સરકારી માર્ગદર્શનનું પાલન કરો.',
    locating: 'તમારું સ્થાન શોધી રહ્યા છીએ...',
    denied: 'સ્થાનની પરવાનગી નકારાઈ. નીચે સ્થાન જાતે દાખલ કરો.',
    unsupported: 'આ ઉપકરણ પર સ્થાન ઉપલબ્ધ નથી. સ્થાન જાતે દાખલ કરો.',
    invalid: 'માન્ય અક્ષાંશ (-90 થી 90) અને રેખાંશ (-180 થી 180) દાખલ કરો.',
    back: 'પાછા',
    updated: 'છેલ્લે અપડેટ',
  },
};

export const LANGS: Array<{ code: Lang; label: string }> = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'gu', label: 'ગુજરાતી' },
];

export function t(lang: Lang, key: Key): string {
  return STR[lang][key];
}
