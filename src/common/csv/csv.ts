/**
 * Чтение и запись CSV (RFC 4180) без внешних зависимостей — решение сессии 0012
 * («импорт/экспорт CSV, без новых зависимостей»).
 *
 * Формат выбран потому, что его открывает и Excel, и Google Sheets, и обычный
 * редактор: выгрузка состава группы (ТЗ 5.5) должна читаться там, где её
 * откроет администратор, а не только программой.
 */

/**
 * Метка порядка байтов. Без неё Excel под Windows читает UTF-8 как cp1251,
 * и кириллические фамилии превращаются в «ÐšÐ°Ñ€Ð¸Ð¼Ð¾Ð²Ð°».
 */
export const CSV_BOM = '\uFEFF';

/** Строка файла: значения ячеек плюс номер строки, каким его видит оператор. */
export interface CsvRecord {
  /**
   * Номер физической строки, с которой начинается запись (1-based, заголовок —
   * строка 1). Именно его показывают в отчёте об ошибках импорта: оператор
   * ищет ошибку в своём файле, а не в нашем массиве.
   */
  line: number;
  values: string[];
}

export interface CsvFormatOptions {
  /** Разделитель колонок. По умолчанию запятая — как в RFC 4180. */
  delimiter?: string;
  /** Дописать BOM в начало (для файлов, которые откроют в Excel). */
  bom?: boolean;
}

/**
 * Excel в русской локали сохраняет CSV с точкой с запятой, все остальные —
 * с запятой. Разделитель определяется по первой строке вне кавычек: заставлять
 * оператора чинить файл, который выгрузил его же Excel, значило бы объявить
 * ошибкой самый частый способ получить CSV.
 */
const detectDelimiter = (text: string): string => {
  let inQuotes = false;
  let commas = 0;
  let semicolons = 0;

  for (const char of text) {
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (char === '\n') break;
    if (char === ',') commas += 1;
    if (char === ';') semicolons += 1;
  }

  return semicolons > commas ? ';' : ',';
};

/**
 * Разбирает CSV в строки со значениями.
 *
 * Поддержано ровно то, что встречается в выгрузках таблиц: кавычки с удвоением
 * (`""` внутри поля), переносы строк внутри кавычек, `\r\n` и `\r`, BOM в начале
 * и оба разделителя (`,` и `;`). Полностью пустые строки отбрасываются —
 * хвост файла и пустая строка между блоками не являются данными.
 */
export const parseCsv = (input: string): CsvRecord[] => {
  // Переводы строк приводятся к `\n` заранее: иначе каждое место разбора
  // пришлось бы писать в трёх вариантах, включая перенос внутри кавычек.
  const text = (input.startsWith(CSV_BOM) ? input.slice(CSV_BOM.length) : input).replace(
    /\r\n?/g,
    '\n',
  );
  const delimiter = detectDelimiter(text);

  const records: CsvRecord[] = [];
  let values: string[] = [];
  let field = '';
  let inQuotes = false;
  let physicalLine = 1;
  let recordLine = 1;
  let index = 0;

  const endField = (): void => {
    values.push(field);
    field = '';
  };

  const endRecord = (): void => {
    endField();
    const isBlank = values.length === 1 && values[0].trim() === '';
    if (!isBlank) {
      records.push({ line: recordLine, values });
    }
    values = [];
  };

  while (index < text.length) {
    const char = text[index];

    if (inQuotes) {
      if (char === '"') {
        // Удвоенная кавычка внутри поля — это одна кавычка в значении.
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      if (char === '\n') physicalLine += 1;
      field += char;
      index += 1;
      continue;
    }

    // Кавычка открывает поле только в его начале: `а"б"в` — это литерал.
    if (char === '"' && field === '') {
      inQuotes = true;
      index += 1;
      continue;
    }

    if (char === delimiter) {
      endField();
      index += 1;
      continue;
    }

    if (char === '\n') {
      endRecord();
      physicalLine += 1;
      recordLine = physicalLine;
      index += 1;
      continue;
    }

    field += char;
    index += 1;
  }

  // Последняя строка без завершающего перевода.
  if (field !== '' || values.length > 0) {
    endRecord();
  }

  return records;
};

/**
 * Значения, начинающиеся с `=` или `@`, Excel исполняет как формулу — на этом
 * держится классическая CSV-инъекция (в поле «причина ухода» можно написать
 * что угодно). Такие ячейки помечаются апострофом: Excel показывает текст.
 *
 * `+` и `−` намеренно не трогаются, хотя классический совет включает и их:
 * с плюса начинается каждый телефон в E.164, и апостроф перед ним сломал бы
 * обратное чтение файла — то самое, ради чего телефон стоит первой колонкой.
 */
const FORMULA_START = /^[=@]/;

const escapeValue = (value: string, delimiter: string): string => {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;

  return safe.includes(delimiter) || /["\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/**
 * Собирает CSV из строк значений. Перевод строки — `\r\n` по RFC 4180
 * (его понимают все, включая старые версии Excel).
 */
export const formatCsv = (
  rows: readonly (readonly string[])[],
  options: CsvFormatOptions = {},
): string => {
  const delimiter = options.delimiter ?? ',';
  const body = rows
    .map((row) => row.map((value) => escapeValue(value, delimiter)).join(delimiter))
    .join('\r\n');

  return `${options.bom === true ? CSV_BOM : ''}${body}${rows.length > 0 ? '\r\n' : ''}`;
};
