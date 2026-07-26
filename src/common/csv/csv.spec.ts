import { CSV_BOM, formatCsv, parseCsv } from './csv';

describe('parseCsv', () => {
  it('разбирает строки и колонки', () => {
    expect(parseCsv('phone,note\n+992901234567,новичок')).toEqual([
      { line: 1, values: ['phone', 'note'] },
      { line: 2, values: ['+992901234567', 'новичок'] },
    ]);
  });

  it('снимает BOM, которым Excel помечает UTF-8', () => {
    expect(parseCsv(`${CSV_BOM}phone\n+992901234567`)).toEqual([
      { line: 1, values: ['phone'] },
      { line: 2, values: ['+992901234567'] },
    ]);
  });

  it('понимает точку с запятой — так CSV сохраняет Excel в русской локали', () => {
    expect(parseCsv('phone;note\n+992901234567;перевёлся')).toEqual([
      { line: 1, values: ['phone', 'note'] },
      { line: 2, values: ['+992901234567', 'перевёлся'] },
    ]);
  });

  it('разделитель определяется по первой строке, а не по всему файлу', () => {
    // В данных запятая встречается чаще, но заголовок разделён точкой с запятой.
    const records = parseCsv('phone;note\n+992901234567;"а, б, в"');

    expect(records[1].values).toEqual(['+992901234567', 'а, б, в']);
  });

  it('снимает кавычки и разворачивает удвоенные', () => {
    expect(parseCsv('note\n"сказал ""ухожу"", ушёл"')).toEqual([
      { line: 1, values: ['note'] },
      { line: 2, values: ['сказал "ухожу", ушёл'] },
    ]);
  });

  it('держит перенос строки внутри кавычек и считает физические строки', () => {
    const records = parseCsv('phone,note\n+992901234567,"первая\nвторая"\n+992985550101,');

    expect(records).toEqual([
      { line: 1, values: ['phone', 'note'] },
      { line: 2, values: ['+992901234567', 'первая\nвторая'] },
      // Запись начинается со строки 4: третью занял хвост многострочного поля.
      { line: 4, values: ['+992985550101', ''] },
    ]);
  });

  it('понимает CRLF', () => {
    expect(parseCsv('phone\r\n+992901234567\r\n')).toEqual([
      { line: 1, values: ['phone'] },
      { line: 2, values: ['+992901234567'] },
    ]);
  });

  it('пропускает пустые строки, но не теряет нумерацию', () => {
    expect(parseCsv('phone\n\n+992901234567\n\n')).toEqual([
      { line: 1, values: ['phone'] },
      { line: 3, values: ['+992901234567'] },
    ]);
  });

  it('читает последнюю строку без завершающего перевода', () => {
    const records = parseCsv('phone\n+992901234567');

    expect(records[1]).toEqual({ line: 2, values: ['+992901234567'] });
  });

  it('пустая строка с разделителем — это две пустые ячейки, а не пропуск', () => {
    expect(parseCsv('a,b\n,')).toEqual([
      { line: 1, values: ['a', 'b'] },
      { line: 2, values: ['', ''] },
    ]);
  });

  it('кавычка в середине поля — обычный символ', () => {
    expect(parseCsv('note\nа"б"в')).toEqual([
      { line: 1, values: ['note'] },
      { line: 2, values: ['а"б"в'] },
    ]);
  });

  it('пустой ввод даёт пустой список', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('\n\n')).toEqual([]);
  });
});

describe('formatCsv', () => {
  it('собирает строки через CRLF и завершает файл переводом', () => {
    expect(formatCsv([['Телефон'], ['+992901234567']])).toBe('Телефон\r\n+992901234567\r\n');
  });

  it('дописывает BOM по требованию — иначе Excel читает UTF-8 как cp1251', () => {
    expect(formatCsv([['Фамилия']], { bom: true })).toBe(`${CSV_BOM}Фамилия\r\n`);
  });

  it('берёт в кавычки значения с разделителем, кавычкой и переносом', () => {
    expect(formatCsv([['а,б', 'в"г', 'д\nе']])).toBe('"а,б","в""г","д\nе"\r\n');
  });

  it('не трогает значения без спецсимволов', () => {
    expect(formatCsv([['Каримова', 'Нигина']])).toBe('Каримова,Нигина\r\n');
  });

  it('экранирует формулу Excel апострофом (CSV-инъекция)', () => {
    expect(formatCsv([['=1+1', '@SUM(A1)']])).toBe("'=1+1,'@SUM(A1)\r\n");
  });

  it('телефон в E.164 остаётся телефоном — плюс не экранируется', () => {
    expect(formatCsv([['+992901234567']])).toBe('+992901234567\r\n');
  });

  it('пустой список не превращается в файл из одного перевода строки', () => {
    expect(formatCsv([])).toBe('');
  });

  it('прочитанное обратно совпадает с записанным', () => {
    const rows = [
      ['Телефон', 'Фамилия', 'Причина'],
      ['+992901234567', 'Каримова', 'сказала «ухожу», ушла'],
      ['+992985550101', 'Раҳимов', 'перевёлся, но вернулся'],
    ];

    expect(parseCsv(formatCsv(rows, { bom: true })).map((record) => record.values)).toEqual(rows);
  });
});
