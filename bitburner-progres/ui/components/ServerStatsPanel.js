/**
 * ServerStatsPanel — displays money and security info for one server.
 *
 * @param {object} props
 * @param {{error:string, currentMoney:number, maxMoney:number, moneyPct:number, minSec:number, baseSec:number, currentSec:number}} props.stats
 * @param {Record<string, object>} props.styles
 */
export function ServerStatsPanel({ stats, styles }) {
  const e = React.createElement;

  if (stats.error) {
    return e("p", { style: styles.error }, "Error: " + stats.error);
  }

  return e(
    React.Fragment,
    null,
    e("p", { style: styles.line }, "Money: " + formatMoney(stats.currentMoney) + " / " + formatMoney(stats.maxMoney)),
    e("p", { style: styles.line }, "Money %: " + formatPercent(stats.moneyPct)),
    e(
      "p",
      { style: styles.line },
      "Security min/base/current: " +
        formatDecimal(stats.minSec) + " / " +
        formatDecimal(stats.baseSec) + " / " +
        formatDecimal(stats.currentSec),
    ),
    e("p", { style: styles.line }, "Security above min: " + formatDecimal(stats.currentSec - stats.minSec)),
  );
}

function formatDecimal(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "0.00";
}

function formatPercent(value) {
  return Number.isFinite(value) ? (value * 100).toFixed(1) + "%" : "0.0%";
}

function formatMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "$0";
  return "$" + n.toLocaleString();
}
