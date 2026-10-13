// CSV compatible con Excel/Power BI: UTF-8 con BOM, separador coma, CRLF.
// Las celdas que empiezan con = + - @ se prefijan con ' para evitar inyección de fórmulas.
const BOM = '\uFEFF';

function celda(valor) {
  if (valor === null || valor === undefined) return '';
  let s = String(valor);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function aCsv(columnas, filas) {
  const lineas = [columnas.map((c) => celda(c.titulo)).join(',')];
  for (const fila of filas) lineas.push(columnas.map((c) => celda(c.valor(fila))).join(','));
  return BOM + lineas.join('\r\n') + '\r\n';
}

module.exports = { aCsv, celda };
