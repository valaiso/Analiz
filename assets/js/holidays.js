/* Borsa İstanbul ve TEFAS'ın kapalı olduğu resmî tatiller.
   Sabit tarihliler her yıl aynıdır; dini bayramlar Diyanet takvimine göre yıl yıl eklenir
   (2028 sonrası için bu listeye yeni yılların eklenmesi gerekir). Hafta sonları ayrıca
   kapalıdır; bu liste yalnızca hafta içine denk gelebilen tatilleri tutar. */

const FIXED_HOLIDAYS = {
  '01-01': 'Yılbaşı',
  '04-23': 'Ulusal Egemenlik ve Çocuk Bayramı',
  '05-01': 'Emek ve Dayanışma Günü',
  '05-19': 'Atatürk’ü Anma, Gençlik ve Spor Bayramı',
  '07-15': 'Demokrasi ve Millî Birlik Günü',
  '08-30': 'Zafer Bayramı',
  '10-29': 'Cumhuriyet Bayramı',
};

const RELIGIOUS_HOLIDAYS = {
  '2026-03-20': 'Ramazan Bayramı', '2026-03-21': 'Ramazan Bayramı', '2026-03-22': 'Ramazan Bayramı',
  '2026-05-27': 'Kurban Bayramı', '2026-05-28': 'Kurban Bayramı', '2026-05-29': 'Kurban Bayramı', '2026-05-30': 'Kurban Bayramı',
  '2027-03-09': 'Ramazan Bayramı', '2027-03-10': 'Ramazan Bayramı', '2027-03-11': 'Ramazan Bayramı',
  '2027-05-16': 'Kurban Bayramı', '2027-05-17': 'Kurban Bayramı', '2027-05-18': 'Kurban Bayramı', '2027-05-19': 'Kurban Bayramı',
  '2028-02-26': 'Ramazan Bayramı', '2028-02-27': 'Ramazan Bayramı', '2028-02-28': 'Ramazan Bayramı',
  '2028-05-04': 'Kurban Bayramı', '2028-05-05': 'Kurban Bayramı', '2028-05-06': 'Kurban Bayramı', '2028-05-07': 'Kurban Bayramı',
};

/** 'YYYY-MM-DD' resmî tatilse adını, değilse null döndürür. */
export const holidayName = (date) => RELIGIOUS_HOLIDAYS[date] || FIXED_HOLIDAYS[String(date).slice(5)] || null;

/** Türkiye piyasası (BIST/TEFAS) o gün kapalı mı: hafta sonu ya da resmî tatil. */
export function isTurkishMarketClosed(date) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day === 0 || day === 6 || Boolean(holidayName(date));
}
