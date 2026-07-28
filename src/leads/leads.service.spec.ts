import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Gender, LeadType } from '@prisma/client';

import { CSV_BOM, BusinessRuleException, SortOrder } from '../common';
import type { AppConfigService } from '../config';
import { PhoneService } from '../phone';
import { LeadQueryDto, LeadSortField } from './dto';
import type { LeadRow, LeadsRepository, LeadTransferWrite } from './leads.repository';
import { LeadsService } from './leads.service';
import type { ExistingStudentProfile, LeadForTransfer } from './leads-transfer';

const LEAD_ID = '11111111-1111-1111-1111-111111111111';
const COURSE_ID = '22222222-2222-2222-2222-222222222222';
const COUPON_ID = '33333333-3333-3333-3333-333333333333';
const BRANCH_ID = '44444444-4444-4444-4444-444444444444';
const STUDENT_ID = '55555555-5555-5555-5555-555555555555';
const OTHER_LEAD_ID = '66666666-6666-6666-6666-666666666666';

const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

const transferable = (overrides: Partial<LeadForTransfer> = {}): LeadForTransfer => ({
  id: LEAD_ID,
  firstName: 'Нигина',
  lastName: 'Каримова',
  phone: '+992901234567',
  email: null,
  birthDate: null,
  gender: null,
  branchId: null,
  convertedStudentId: null,
  ...overrides,
});

const existing = (overrides: Partial<ExistingStudentProfile> = {}): ExistingStudentProfile => ({
  id: STUDENT_ID,
  phone: '+992901234567',
  lastName: 'Каримова',
  firstName: 'Нигина',
  leadOriginId: null,
  ...overrides,
});

const row = (overrides: Partial<LeadRow> = {}): LeadRow => ({
  id: LEAD_ID,
  firstName: 'Нигина',
  lastName: 'Каримова',
  phone: '+992901234567',
  email: null,
  birthDate: null,
  gender: null,
  occupation: null,
  enrollMonth: null,
  lessonTimeMinute: null,
  notes: null,
  source: null,
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
  type: LeadType.LEAD,
  becameClientAt: null,
  convertedStudentId: null,
  convertedAt: null,
  createdAt: new Date('2026-08-15T10:00:00.000Z'),
  course: null,
  coupon: null,
  branch: null,
  ...overrides,
});

// Настоящий экземпляр DTO, а не литерал: `skip`/`take` — вычисляемые геттеры.
const query = (overrides: Partial<LeadQueryDto> = {}): LeadQueryDto =>
  Object.assign(new LeadQueryDto(), overrides);

const base = { firstName: 'Нигина', lastName: 'Каримова', phone: '+992901234567' };

describe('LeadsService (ТЗ 5.7)', () => {
  let repository: jest.Mocked<
    Pick<
      LeadsRepository,
      | 'findMany'
      | 'findById'
      | 'countByPhone'
      | 'create'
      | 'update'
      | 'delete'
      | 'findAllForExport'
      | 'findManyForTransfer'
      | 'findStudentsByPhones'
      | 'transfer'
      | 'findCourse'
      | 'findCoupon'
      | 'findBranch'
    >
  >;
  let service: LeadsService;

  beforeEach(() => {
    repository = {
      findMany: jest.fn().mockResolvedValue({ rows: [row()], total: 1 }),
      findById: jest.fn().mockResolvedValue(row()),
      countByPhone: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockImplementation(() => Promise.resolve(row())),
      update: jest.fn().mockImplementation(() => Promise.resolve(row())),
      delete: jest.fn().mockResolvedValue(undefined),
      findAllForExport: jest.fn().mockResolvedValue([row()]),
      findManyForTransfer: jest.fn().mockResolvedValue([transferable()]),
      findStudentsByPhones: jest.fn().mockResolvedValue([]),
      transfer: jest
        .fn()
        .mockImplementation((writes: LeadTransferWrite[]) =>
          Promise.resolve(
            writes.map(({ leadId, studentId }) => ({ leadId, studentId: studentId ?? STUDENT_ID })),
          ),
        ),
      findCourse: jest.fn().mockResolvedValue({ id: COURSE_ID, title: 'Frontend' }),
      findCoupon: jest.fn().mockResolvedValue({ id: COUPON_ID, name: 'OSEN-2026' }),
      findBranch: jest.fn().mockResolvedValue({ id: BRANCH_ID, name: 'Sadbarg' }),
    };

    const phones = new PhoneService({ defaultPhoneRegion: 'TJ' } as AppConfigService);
    service = new LeadsService(repository as unknown as LeadsRepository, phones);
  });

  describe('Список и карточка', () => {
    it('отдаёт курс, купон и филиал именованными ссылками', async () => {
      repository.findById.mockResolvedValue(
        row({
          course: { id: COURSE_ID, title: 'Frontend' },
          coupon: { id: COUPON_ID, name: 'OSEN-2026' },
          branch: { id: BRANCH_ID, name: 'Sadbarg' },
        }),
      );

      await expect(service.findOne(LEAD_ID)).resolves.toMatchObject({
        course: { id: COURSE_ID, name: 'Frontend' },
        coupon: { id: COUPON_ID, name: 'OSEN-2026' },
        branch: { id: BRANCH_ID, name: 'Sadbarg' },
      });
    });

    it('месяц записи отдаётся как `YYYY-MM`, дата рождения — как `YYYY-MM-DD`', async () => {
      repository.findById.mockResolvedValue(
        row({ enrollMonth: day('2026-09-01'), birthDate: day('2004-05-17') }),
      );

      await expect(service.findOne(LEAD_ID)).resolves.toMatchObject({
        enrollMonth: '2026-09',
        birthDate: '2004-05-17',
      });
    });

    it('время урока отдаётся как `HH:MM`, а не минутами', async () => {
      repository.findById.mockResolvedValue(row({ lessonTimeMinute: 18 * 60 + 30 }));

      await expect(service.findOne(LEAD_ID)).resolves.toMatchObject({ lessonTime: '18:30' });
    });

    it('UTM-метки собираются в объект, незаполненные — `null`', async () => {
      repository.findById.mockResolvedValue(row({ utmSource: 'instagram', utmMedium: 'cpc' }));

      await expect(service.findOne(LEAD_ID)).resolves.toMatchObject({
        utm: { source: 'instagram', medium: 'cpc', campaign: null },
      });
    });

    it('непереведённый лид отдаёт `converted: false` и пустые поля перевода', async () => {
      await expect(service.findOne(LEAD_ID)).resolves.toMatchObject({
        conversion: { converted: false, studentId: null, convertedAt: null },
      });
    });

    it('«переведён» выводится из ссылки на профиль, а не из отдельного флага', async () => {
      repository.findById.mockResolvedValue(
        row({
          convertedStudentId: STUDENT_ID,
          convertedAt: new Date('2026-09-02T08:30:00.000Z'),
        }),
      );

      await expect(service.findOne(LEAD_ID)).resolves.toMatchObject({
        conversion: {
          converted: true,
          studentId: STUDENT_ID,
          convertedAt: '2026-09-02T08:30:00.000Z',
        },
      });
    });

    it('передаёт окно страницы, все фильтры и сортировку', async () => {
      await service.findAll(
        query({
          page: 2,
          limit: 15,
          search: 'карим',
          type: LeadType.CLIENT,
          courseId: COURSE_ID,
          branchId: BRANCH_ID,
          couponId: COUPON_ID,
          enrollMonth: '2026-09',
          converted: false,
          sort: LeadSortField.Name,
          order: SortOrder.Asc,
        }),
      );

      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 15,
          take: 15,
          search: 'карим',
          type: LeadType.CLIENT,
          courseId: COURSE_ID,
          branchId: BRANCH_ID,
          couponId: COUPON_ID,
          enrollMonth: day('2026-09-01'),
          converted: false,
          sort: LeadSortField.Name,
          order: SortOrder.Asc,
        }),
      );
    });

    it('период обращения переводится в отрезок с невключающей правой границей', async () => {
      await service.findAll(query({ from: '2026-01', to: '2026-03' }));

      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ from: day('2026-01-01'), to: day('2026-04-01') }),
      );
    });

    it('без периода границы до БД не доходят', async () => {
      await service.findAll(query());

      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ from: undefined, to: undefined }),
      );
    });

    it('400 на несуществующий месяц в фильтре — до запроса списка', async () => {
      await expect(service.findAll(query({ from: '2026-13' }))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repository.findMany).not.toHaveBeenCalled();
    });

    it('404 на неизвестного лида', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.findOne(LEAD_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('Создание', () => {
    it('нормализует телефон в E.164', async () => {
      await service.create({ ...base, phone: '901234567' });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ phone: '+992901234567' }),
      );
    });

    it('разбирает месяц записи, дату рождения и время урока', async () => {
      await service.create({
        ...base,
        enrollMonth: '2026-09',
        birthDate: '2004-05-17',
        lessonTime: '18:30',
      });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          enrollMonth: day('2026-09-01'),
          birthDate: day('2004-05-17'),
          lessonTimeMinute: 1110,
        }),
      );
    });

    it('незаполненные поля кладутся как `null`, а не как `undefined`', async () => {
      await service.create(base);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          email: null,
          birthDate: null,
          occupation: null,
          enrollMonth: null,
          courseId: null,
          lessonTimeMinute: null,
          notes: null,
          source: null,
          utmSource: null,
          couponId: null,
          branchId: null,
        }),
      );
    });

    it('телефон на занятость не проверяется — заводит второе обращение того же человека', async () => {
      repository.countByPhone.mockResolvedValue(2);

      const created = await service.create(base);

      expect(created.duplicatePhoneCount).toBe(2);
      expect(repository.create).toHaveBeenCalled();
    });

    it('первое обращение отдаёт `duplicatePhoneCount: 0`', async () => {
      await expect(service.create(base)).resolves.toMatchObject({ duplicatePhoneCount: 0 });
    });

    it('подсказка о дублях считается **без** самого созданного лида', async () => {
      await service.create(base);

      expect(repository.countByPhone).toHaveBeenCalledWith('+992901234567', LEAD_ID);
    });

    it('заведённый сразу клиентом получает дату перехода', async () => {
      await service.create({ ...base, type: LeadType.CLIENT });

      const input = repository.create.mock.calls[0]?.[0];
      expect(input?.becameClientAt).toBeInstanceOf(Date);
    });

    it('обычный лид дату перехода не получает', async () => {
      await service.create(base);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ becameClientAt: undefined }),
      );
    });

    it('пол и заметки доходят до БД как переданы', async () => {
      await service.create({ ...base, gender: Gender.FEMALE, notes: 'перезвонить после 18:00' });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ gender: Gender.FEMALE, notes: 'перезвонить после 18:00' }),
      );
    });

    it('400 на неразобранный телефон — до всех остальных запросов', async () => {
      await expect(service.create({ ...base, phone: 'не телефон' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('400 на несуществующую дату рождения', async () => {
      await expect(service.create({ ...base, birthDate: '2004-02-30' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('422 на несуществующий курс — лид не заведён', async () => {
      repository.findCourse.mockResolvedValue(null);

      const error = await service.create({ ...base, courseId: COURSE_ID }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BusinessRuleException);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('422 на несуществующий купон', async () => {
      repository.findCoupon.mockResolvedValue(null);

      await expect(service.create({ ...base, couponId: COUPON_ID })).rejects.toBeInstanceOf(
        BusinessRuleException,
      );
    });

    it('422 на несуществующий филиал', async () => {
      repository.findBranch.mockResolvedValue(null);

      await expect(service.create({ ...base, branchId: BRANCH_ID })).rejects.toBeInstanceOf(
        BusinessRuleException,
      );
    });

    it('без ссылок в теле справочники не спрашиваются', async () => {
      await service.create(base);

      expect(repository.findCourse).not.toHaveBeenCalled();
      expect(repository.findCoupon).not.toHaveBeenCalled();
      expect(repository.findBranch).not.toHaveBeenCalled();
    });
  });

  describe('Правка', () => {
    it('не переданные поля до БД не доходят', async () => {
      await service.update(LEAD_ID, { notes: 'перезвонить' });

      expect(repository.update).toHaveBeenCalledWith(
        LEAD_ID,
        expect.objectContaining({ notes: 'перезвонить', phone: undefined, email: undefined }),
      );
    });

    it('пустая строка очищает поле и снимает ссылку на курс', async () => {
      await service.update(LEAD_ID, { notes: '', courseId: '' });

      expect(repository.update).toHaveBeenCalledWith(
        LEAD_ID,
        expect.objectContaining({ notes: null, courseId: null }),
      );
      expect(repository.findCourse).not.toHaveBeenCalled();
    });

    it('пустая строка снимает месяц записи и время урока', async () => {
      await service.update(LEAD_ID, { enrollMonth: '', lessonTime: '' });

      expect(repository.update).toHaveBeenCalledWith(
        LEAD_ID,
        expect.objectContaining({ enrollMonth: null, lessonTimeMinute: null }),
      );
    });

    it('новый телефон нормализуется в E.164', async () => {
      await service.update(LEAD_ID, { phone: '92 111-22-33' });

      expect(repository.update).toHaveBeenCalledWith(
        LEAD_ID,
        expect.objectContaining({ phone: '+992921112233' }),
      );
    });

    it('LEAD → CLIENT проставляет дату перехода', async () => {
      await service.update(LEAD_ID, { type: LeadType.CLIENT });

      const input = repository.update.mock.calls[0]?.[1];
      expect(input?.becameClientAt).toBeInstanceOf(Date);
    });

    it('CLIENT → LEAD снимает дату перехода', async () => {
      repository.findById.mockResolvedValue(
        row({ type: LeadType.CLIENT, becameClientAt: new Date('2026-08-20T12:00:00.000Z') }),
      );

      await service.update(LEAD_ID, { type: LeadType.LEAD });

      expect(repository.update).toHaveBeenCalledWith(
        LEAD_ID,
        expect.objectContaining({ becameClientAt: null }),
      );
    });

    it('правка без смены стадии дату перехода не трогает', async () => {
      repository.findById.mockResolvedValue(
        row({ type: LeadType.CLIENT, becameClientAt: new Date('2026-08-20T12:00:00.000Z') }),
      );

      await service.update(LEAD_ID, { notes: 'ещё раз позвонить' });

      expect(repository.update).toHaveBeenCalledWith(
        LEAD_ID,
        expect.objectContaining({ becameClientAt: undefined }),
      );
    });

    it('та же стадия в теле дату перехода не переписывает', async () => {
      repository.findById.mockResolvedValue(row({ type: LeadType.CLIENT }));

      await service.update(LEAD_ID, { type: LeadType.CLIENT });

      expect(repository.update).toHaveBeenCalledWith(
        LEAD_ID,
        expect.objectContaining({ becameClientAt: undefined }),
      );
    });

    it('422 на несуществующий купон — лид не изменён', async () => {
      repository.findCoupon.mockResolvedValue(null);

      await expect(service.update(LEAD_ID, { couponId: COUPON_ID })).rejects.toBeInstanceOf(
        BusinessRuleException,
      );
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('404 до всех проверок', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.update(LEAD_ID, { couponId: COUPON_ID })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repository.findCoupon).not.toHaveBeenCalled();
    });
  });

  describe('Удаление', () => {
    it('удаляет лида без ограничений и называет его в ответе', async () => {
      await expect(service.remove(LEAD_ID)).resolves.toMatchObject({
        id: LEAD_ID,
        name: 'Каримова Нигина',
      });
      expect(repository.delete).toHaveBeenCalledWith(LEAD_ID);
    });

    it('переведённый лид удаляется тоже: это способ освободить ошибочный профиль', async () => {
      repository.findById.mockResolvedValue(row({ convertedStudentId: STUDENT_ID }));

      await expect(service.remove(LEAD_ID)).resolves.toBeDefined();
      expect(repository.delete).toHaveBeenCalledWith(LEAD_ID);
    });

    it('404 на удаление неизвестного лида', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.remove(LEAD_ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.delete).not.toHaveBeenCalled();
    });
  });

  describe('Перевод в студенты (ТЗ 5.7)', () => {
    it('заводит профиль и называет действие `created`', async () => {
      await expect(service.transfer({ leadIds: [LEAD_ID] })).resolves.toEqual({
        transferred: [
          { leadId: LEAD_ID, name: 'Каримова Нигина', studentId: STUDENT_ID, action: 'created' },
        ],
        created: 1,
        linked: 0,
      });
    });

    it('в новый профиль уходят поля человека, а не поля обращения', async () => {
      repository.findManyForTransfer.mockResolvedValue([
        transferable({
          email: 'nigina@mail.tj',
          birthDate: day('2004-05-17'),
          gender: Gender.FEMALE,
          branchId: BRANCH_ID,
        }),
      ]);

      await service.transfer({ leadIds: [LEAD_ID] });

      expect(repository.transfer).toHaveBeenCalledWith(
        [
          {
            leadId: LEAD_ID,
            studentId: null,
            profile: {
              firstName: 'Нигина',
              lastName: 'Каримова',
              phone: '+992901234567',
              email: 'nigina@mail.tj',
              birthDate: day('2004-05-17'),
              gender: Gender.FEMALE,
              branchId: BRANCH_ID,
            },
          },
        ],
        expect.any(Date),
      );
    });

    it('занятый телефон привязывает к существующему профилю (`linked`), а не отказывает', async () => {
      repository.findStudentsByPhones.mockResolvedValue([existing()]);

      await expect(service.transfer({ leadIds: [LEAD_ID] })).resolves.toMatchObject({
        transferred: [{ leadId: LEAD_ID, studentId: STUDENT_ID, action: 'linked' }],
        created: 0,
        linked: 1,
      });
      // Второй профиль не заводится: `Student.phone` уникален с Фазы 1.
      expect(repository.transfer).toHaveBeenCalledWith(
        [expect.objectContaining({ studentId: STUDENT_ID })],
        expect.any(Date),
      );
    });

    it('считает заведённые и привязанные раздельно', async () => {
      repository.findManyForTransfer.mockResolvedValue([
        transferable({ id: LEAD_ID }),
        transferable({ id: OTHER_LEAD_ID, phone: '+992905550000' }),
      ]);
      repository.findStudentsByPhones.mockResolvedValue([existing()]);

      await expect(service.transfer({ leadIds: [LEAD_ID, OTHER_LEAD_ID] })).resolves.toMatchObject({
        created: 1,
        linked: 1,
      });
    });

    it('профили ищутся по телефонам найденных обращений, без повторов', async () => {
      repository.findManyForTransfer.mockResolvedValue([
        transferable({ id: LEAD_ID }),
        transferable({ id: OTHER_LEAD_ID }),
      ]);

      await service.transfer({ leadIds: [LEAD_ID, OTHER_LEAD_ID] }).catch(() => undefined);

      expect(repository.findStudentsByPhones).toHaveBeenCalledWith(['+992901234567']);
    });

    it('422 на уже переведённое обращение — не переведён никто', async () => {
      repository.findManyForTransfer.mockResolvedValue([
        transferable({ convertedStudentId: STUDENT_ID }),
      ]);

      await expect(service.transfer({ leadIds: [LEAD_ID] })).rejects.toBeInstanceOf(
        BusinessRuleException,
      );
      expect(repository.transfer).not.toHaveBeenCalled();
    });

    it('422 на несуществующее обращение', async () => {
      repository.findManyForTransfer.mockResolvedValue([]);

      await expect(service.transfer({ leadIds: [LEAD_ID] })).rejects.toBeInstanceOf(
        BusinessRuleException,
      );
      expect(repository.transfer).not.toHaveBeenCalled();
    });

    it('422 на профиль, заведённый из другого обращения', async () => {
      repository.findStudentsByPhones.mockResolvedValue([
        existing({ leadOriginId: OTHER_LEAD_ID }),
      ]);

      await expect(service.transfer({ leadIds: [LEAD_ID] })).rejects.toBeInstanceOf(
        BusinessRuleException,
      );
      expect(repository.transfer).not.toHaveBeenCalled();
    });

    it('отказ несёт отчёт по строкам и их общее число', async () => {
      repository.findManyForTransfer.mockResolvedValue([
        transferable({ convertedStudentId: STUDENT_ID }),
      ]);

      await expect(service.transfer({ leadIds: [LEAD_ID, OTHER_LEAD_ID] })).rejects.toMatchObject({
        response: {
          details: {
            total: 2,
            rejected: [
              { leadId: LEAD_ID, reason: expect.stringContaining('уже переведено') },
              { leadId: OTHER_LEAD_ID, reason: expect.stringContaining('не найдено') },
            ],
          },
        },
      });
    });

    it('одна годная строка не спасает пачку: применяется всё или ничего', async () => {
      repository.findManyForTransfer.mockResolvedValue([transferable({ id: LEAD_ID })]);

      await expect(service.transfer({ leadIds: [LEAD_ID, OTHER_LEAD_ID] })).rejects.toBeInstanceOf(
        BusinessRuleException,
      );
      expect(repository.transfer).not.toHaveBeenCalled();
    });
  });

  describe('Выгрузка в CSV (ТЗ 5.7)', () => {
    it('файл начинается с BOM — иначе Excel читает UTF-8 как cp1251', async () => {
      const file = await service.exportCsv({});

      expect(file.content.startsWith(CSV_BOM)).toBe(true);
    });

    it('заголовок и строка на каждое обращение', async () => {
      repository.findAllForExport.mockResolvedValue([row(), row({ id: OTHER_LEAD_ID })]);

      const file = await service.exportCsv({});

      expect(file.content.trimEnd().split('\r\n')).toHaveLength(3);
      expect(file.rows).toBe(2);
    });

    it('пустая выборка отдаёт файл из одного заголовка, а не пустой', async () => {
      repository.findAllForExport.mockResolvedValue([]);

      const file = await service.exportCsv({});

      expect(file.content.trimEnd().split('\r\n')).toHaveLength(1);
      expect(file.rows).toBe(0);
    });

    it('передаёт доменные фильтры без окна страницы', async () => {
      await service.exportCsv({
        type: LeadType.CLIENT,
        courseId: COURSE_ID,
        enrollMonth: '2026-09',
        from: '2026-01',
        to: '2026-06',
        search: 'instagram',
      });

      expect(repository.findAllForExport).toHaveBeenCalledWith({
        type: LeadType.CLIENT,
        courseId: COURSE_ID,
        branchId: undefined,
        couponId: undefined,
        enrollMonth: day('2026-09-01'),
        converted: undefined,
        from: day('2026-01-01'),
        // Правая граница не включающая: «по июнь» — это весь июнь.
        to: day('2026-07-01'),
        search: 'instagram',
      });
    });

    it('400 на негодный месяц — до запроса в БД', async () => {
      await expect(service.exportCsv({ from: '2026-13' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repository.findAllForExport).not.toHaveBeenCalled();
    });

    it('имя файла с датой, ASCII-запасное — без кириллицы', async () => {
      const file = await service.exportCsv({});

      expect(file.fileName).toMatch(/^Лиды \d{4}-\d{2}-\d{2}\.csv$/);
      expect(file.asciiFileName).toMatch(/^leads-\d{4}-\d{2}-\d{2}\.csv$/);
    });
  });
});
