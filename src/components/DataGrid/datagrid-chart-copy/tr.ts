import type { DataGridChartCopy } from "./types";

export const TR_COPY: DataGridChartCopy = {
  chart: {
    title: "Grafik",
    buttonTitle: "Bu sonucu grafiğe dök",
    type: "Grafik türü",
    xAxis: "X ekseni",
    yAxis: "Y ekseni",
    value: "Değer",
    close: "Kapat",
    noRows: "Görselleştirilecek veri yok.",
    noNumeric: "Grafik için sayısal sütun bulunamadı.",
  },
  autoRefresh: {
    title: "Otomatik yenileme",
    off: "Kapalı",
    everySeconds: (seconds) => `Her ${seconds} saniyede`,
    countdown: (seconds) => `${seconds}sn`,
    stoppedForEdit: "Düzenleme sırasında otomatik yenileme durduruldu",
  },
};
