import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { GraduateEmployment, StudentStatus } from '@prisma/client';

import { SortOrder } from '../common';
import { ActivityCategory } from '../performance/performance';
import { GraduatesQueryDto, GraduateSortField } from './dto';
import type { GraduateRow, GraduatesRepository, GraduationGroup } from './graduates.repository';
import { GRADUATION_STATUS_REASON, GraduatesService } from './graduates.service';
import { PdfGeneratorService } from '../documents/pdf-generator.service';

const GRADUATE_ID = '11111111-1111-1111-1111-111111111111';
const STUDENT_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_STUDENT_ID = '77777777-7777-7777-7777-777777777777';
const GROUP_ID = '33333333-3333-3333-3333-333333333333';
const COURSE_ID = '44444444-4444-4444-4444-444444444444';
const BRANCH_ID = '55555555-5555-5555-5555-555555555555';
const ACCOUNT_ID = '66666666-6666-6666-6666-666666666666';
const EMPLOYEE_ID = '88888888-8888-8888-8888-888888888888';

const row = (overrides: Partial<GraduateRow> = {}): GraduateRow => ({
  id: GRADUATE_ID,
  graduatedAt: new Date('2026-06-30T00:00:00.000Z'),
  points: 87.33 as unknown as GraduateRow['points'],
  weeksCount: 12,
  employment: null,
  workPlace: null,
  certificateSerial: null,
  certificateIssuedAt: null,
  createdAt: new Date('2026-06-30T09:12:00.000Z'),
  student: {
    id: STUDENT_ID,
    firstName: 'Нигина',
    lastName: 'Каримова',
    phone: '+992901234567',
    photoUrl: null,
    status: StudentStatus.FINISHED,
  },
  group: {
    id: GROUP_ID,
    name: 'Frontend-3',
    course: { id: COURSE_ID, title: 'Frontend Pro' },
    branch: { id: BRANCH_ID, name: 'Sadbarg' },
  },
  certificateIssuedBy: null,
  ...overrides,
});

const group = (overrides: Partial<GraduationGroup> = {}): GraduationGroup => ({
  id: GROUP_ID,
  name: 'Frontend-3',
  endDate: new Date('2026-06-30T00:00:00.000Z'),
  course: { id: COURSE_ID, title: 'Frontend Pro', isLastCourse: true },
  ...overrides,
});

// Настоящий экземпляр DTO, а не литерал: `skip`/`take` — вычисляемые геттеры,
// и подделанные значения скрыли бы ошибку в переводе страницы в окно выборки.
const query = (overrides: Partial<GraduatesQueryDto> = {}): GraduatesQueryDto =>
  Object.assign(new GraduatesQueryDto(), overrides);

describe('GraduatesService', () => {
  let repository: jest.Mocked<
    Pick<
      GraduatesRepository,
      | 'findMany'
      | 'countByEmployment'
      | 'findById'
      | 'findBySerial'
      | 'update'
      | 'issueCertificate'
      | 'revokeCertificate'
      | 'findGroupForGraduation'
      | 'findActiveMemberIds'
      | 'findGraduatedStudentIds'
      | 'findScores'
      | 'graduate'
      | 'findStudentsWithMemberships'
      | 'setStudentStatuses'
      | 'findEmployeeByAccount'
    >
  >;
  let service: GraduatesService;

  beforeEach(() => {
    repository = {
      findMany: jest.fn().mockResolvedValue({ rows: [row()], total: 1 }),
      countByEmployment: jest.fn().mockResolvedValue([]),
      findById: jest.fn().mockResolvedValue(row()),
      findBySerial: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockImplementation(() => Promise.resolve(row())),
      issueCertificate: jest.fn().mockImplementation(() => Promise.resolve(row())),
      revokeCertificate: jest.fn().mockImplementation(() => Promise.resolve(row())),
      findGroupForGraduation: jest.fn().mockResolvedValue(group()),
      findActiveMemberIds: jest.fn().mockResolvedValue([STUDENT_ID]),
      findGraduatedStudentIds: jest.fn().mockResolvedValue([]),
      findScores: jest
        .fn()
        .mockResolvedValue([{ studentId: STUDENT_ID, average: 87.334, weeksCount: 12 }]),
      graduate: jest.fn().mockResolvedValue([row()]),
      findStudentsWithMemberships: jest.fn().mockResolvedValue([]),
      setStudentStatuses: jest.fn().mockResolvedValue(undefined),
      findEmployeeByAccount: jest.fn().mockResolvedValue({ id: EMPLOYEE_ID }),
    };

    service = new GraduatesService(
      repository as unknown as GraduatesRepository,
      new PdfGeneratorService(),
    );
  });

  describe('Список и карточка', () => {
    it('отдаёт выпуск со студентом, группой, курсом и филиалом', async () => {
      const result = await service.findAll(query());

      expect(result.meta).toMatchObject({ total: 1, page: 1, limit: 20 });
      expect(result.items[0]).toMatchObject({
        id: GRADUATE_ID,
        student: { id: STUDENT_ID, lastName: 'Каримова' },
        group: { id: GROUP_ID, name: 'Frontend-3' },
        course: { id: COURSE_ID, name: 'Frontend Pro' },
        branch: { id: BRANCH_ID, name: 'Sadbarg' },
      });
    });

    it('дата выпуска отдаётся календарной, без времени', async () => {
      const result = await service.findAll(query());

      expect(result.items[0]).toMatchObject({
        graduatedAt: '2026-06-30',
        createdAt: '2026-06-30T09:12:00.000Z',
      });
    });

    it('уровень выводится из замороженного балла, а не считается заново', async () => {
      const result = await service.findAll(query());

      expect(result.items[0]).toMatchObject({
        points: 87.33,
        level: ActivityCategory.Handsome,
        levelTitle: 'Handsome',
      });
    });

    it('у выпускника без балла нет и уровня — это null, а не Black list', async () => {
      repository.findMany.mockResolvedValue({
        rows: [row({ points: null, weeksCount: 0 })],
        total: 1,
      });

      const result = await service.findAll(query());

      expect(result.items[0]).toMatchObject({ points: null, level: null, levelTitle: null });
    });

    it('сертификат отдаётся объектом, и «выдан» выводится из наличия номера', async () => {
      repository.findMany.mockResolvedValue({
        rows: [
          row({
            certificateSerial: 'OMZ-2026-000148',
            certificateIssuedAt: new Date('2026-07-05T00:00:00.000Z'),
            certificateIssuedBy: { id: EMPLOYEE_ID, firstName: 'Фаррух', lastName: 'Раҳимов' },
          }),
        ],
        total: 1,
      });

      const result = await service.findAll(query());

      expect(result.items[0]?.certificate).toEqual({
        issued: true,
        serial: 'OMZ-2026-000148',
        issuedAt: '2026-07-05',
        issuedBy: { id: EMPLOYEE_ID, firstName: 'Фаррух', lastName: 'Раҳимов' },
      });
    });

    it('невыданный сертификат — issued: false и пустые поля', async () => {
      const result = await service.findAll(query());

      expect(result.items[0]?.certificate).toEqual({
        issued: false,
        serial: null,
        issuedAt: null,
        issuedBy: null,
      });
    });

    it('передаёт окно страницы, фильтры и сортировку в выборку', async () => {
      await service.findAll(
        query({
          page: 3,
          limit: 10,
          groupId: GROUP_ID,
          courseId: COURSE_ID,
          branchId: BRANCH_ID,
          employment: GraduateEmployment.WORK,
          hasCertificate: true,
          search: 'Каримова',
          sort: GraduateSortField.Points,
          order: SortOrder.Asc,
        }),
      );

      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 20,
          take: 10,
          groupId: GROUP_ID,
          courseId: COURSE_ID,
          branchId: BRANCH_ID,
          employment: GraduateEmployment.WORK,
          hasCertificate: true,
          search: 'Каримова',
          sort: GraduateSortField.Points,
          order: SortOrder.Asc,
        }),
      );
    });

    it('по умолчанию свежие выпуски сверху', async () => {
      await service.findAll(query());

      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ sort: GraduateSortField.GraduatedAt, order: SortOrder.Desc }),
      );
    });

    it('без периода границы до выборки не доходят', async () => {
      await service.findAll(query());

      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ from: undefined, to: undefined }),
      );
    });

    it('период месяцев переводится в отрезок с невключающей правой границей', async () => {
      await service.findAll(query({ from: '2026-01', to: '2026-03' }));

      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          from: new Date('2026-01-01T00:00:00.000Z'),
          to: new Date('2026-04-01T00:00:00.000Z'),
        }),
      );
    });

    it('400 на негодный месяц — до обращения к БД', async () => {
      await expect(service.findAll(query({ from: '2026-13' }))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repository.findMany).not.toHaveBeenCalled();
    });

    it('счётчики трудоустройства уходят в meta и считаются по тому же отбору', async () => {
      repository.countByEmployment.mockResolvedValue([
        { employment: GraduateEmployment.WORK, count: 11 },
        { employment: null, count: 7 },
      ]);

      const result = await service.findAll(query({ courseId: COURSE_ID }));

      expect(result.meta.employment).toEqual({
        openToWork: 0,
        work: 11,
        freelancer: 0,
        furtherEducation: 0,
        entrepreneur: 0,
        unknown: 7,
      });
      expect(repository.countByEmployment).toHaveBeenCalledWith(
        expect.objectContaining({ courseId: COURSE_ID }),
      );
    });

    it('счётчики не сужаются страницей: окно в них не передаётся', async () => {
      await service.findAll(query({ page: 2, limit: 5 }));

      expect(repository.countByEmployment).toHaveBeenCalledWith(
        expect.not.objectContaining({ skip: expect.anything() }),
      );
    });

    it('карточка выпускника ищется по идентификатору', async () => {
      const result = await service.findOne(GRADUATE_ID);

      expect(repository.findById).toHaveBeenCalledWith(GRADUATE_ID);
      expect(result.id).toBe(GRADUATE_ID);
    });

    it('404 на неизвестного выпускника', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.findOne(GRADUATE_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('Правка карточки', () => {
    it('проставляет трудоустройство и место работы', async () => {
      await service.update(GRADUATE_ID, {
        employment: GraduateEmployment.WORK,
        workPlace: 'ООО «Алиф Технолоджи»',
      });

      expect(repository.update).toHaveBeenCalledWith(GRADUATE_ID, {
        employment: GraduateEmployment.WORK,
        workPlace: 'ООО «Алиф Технолоджи»',
        graduatedAt: undefined,
      });
    });

    it('не переданные поля до БД не доходят', async () => {
      await service.update(GRADUATE_ID, {});

      expect(repository.update).toHaveBeenCalledWith(GRADUATE_ID, {
        employment: undefined,
        workPlace: undefined,
        graduatedAt: undefined,
      });
    });

    it('пустая строка очищает место работы', async () => {
      await service.update(GRADUATE_ID, { workPlace: '' });

      expect(repository.update).toHaveBeenCalledWith(
        GRADUATE_ID,
        expect.objectContaining({ workPlace: null }),
      );
    });

    it('null снимает статус трудоустройства обратно в «не выяснен»', async () => {
      await service.update(GRADUATE_ID, { employment: null });

      expect(repository.update).toHaveBeenCalledWith(
        GRADUATE_ID,
        expect.objectContaining({ employment: null }),
      );
    });

    it('дата выпуска правится и приходит календарной', async () => {
      await service.update(GRADUATE_ID, { graduatedAt: '2026-07-01' });

      expect(repository.update).toHaveBeenCalledWith(
        GRADUATE_ID,
        expect.objectContaining({ graduatedAt: new Date('2026-07-01T00:00:00.000Z') }),
      );
    });

    it('400 на несуществующую дату (30 февраля)', async () => {
      await expect(
        service.update(GRADUATE_ID, { graduatedAt: '2026-02-30' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('404 до записи', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(
        service.update(GRADUATE_ID, { employment: GraduateEmployment.WORK }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.update).not.toHaveBeenCalled();
    });
  });

  describe('Сертификат', () => {
    it('выдаёт сертификат с номером, датой и подписью сотрудника из токена', async () => {
      await service.issueCertificate(
        GRADUATE_ID,
        { serial: 'OMZ-2026-000148', issuedAt: '2026-07-05' },
        ACCOUNT_ID,
      );

      expect(repository.findEmployeeByAccount).toHaveBeenCalledWith(ACCOUNT_ID);
      expect(repository.issueCertificate).toHaveBeenCalledWith(GRADUATE_ID, {
        serial: 'OMZ-2026-000148',
        issuedAt: new Date('2026-07-05T00:00:00.000Z'),
        issuedById: EMPLOYEE_ID,
      });
    });

    it('без даты выдачи ставит сегодняшнюю полночь UTC', async () => {
      await service.issueCertificate(GRADUATE_ID, { serial: 'OMZ-1' }, ACCOUNT_ID);

      const issuedAt = repository.issueCertificate.mock.calls[0]?.[1].issuedAt;

      expect(issuedAt?.getUTCHours()).toBe(0);
      expect(issuedAt?.getUTCMinutes()).toBe(0);
      expect(issuedAt?.getUTCSeconds()).toBe(0);
      expect(issuedAt?.getUTCMilliseconds()).toBe(0);
    });

    it('аккаунт без профиля сотрудника выдаёт сертификат без подписи', async () => {
      repository.findEmployeeByAccount.mockResolvedValue(null);

      await service.issueCertificate(GRADUATE_ID, { serial: 'OMZ-1' }, ACCOUNT_ID);

      expect(repository.issueCertificate).toHaveBeenCalledWith(
        GRADUATE_ID,
        expect.objectContaining({ issuedById: null }),
      );
    });

    it('409 на повторную выдачу — прежний номер называется в тексте', async () => {
      repository.findById.mockResolvedValue(row({ certificateSerial: 'OMZ-2026-000001' }));

      await expect(
        service.issueCertificate(GRADUATE_ID, { serial: 'OMZ-2026-000148' }, ACCOUNT_ID),
      ).rejects.toThrow(/OMZ-2026-000001/);
      expect(repository.issueCertificate).not.toHaveBeenCalled();
    });

    it('409 на номер, занятый другим выпускником', async () => {
      repository.findBySerial.mockResolvedValue({
        id: 'other',
        certificateSerial: 'OMZ-2026-000148',
      });

      await expect(
        service.issueCertificate(GRADUATE_ID, { serial: 'OMZ-2026-000148' }, ACCOUNT_ID),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repository.issueCertificate).not.toHaveBeenCalled();
    });

    it('404 до поиска занятого номера', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(
        service.issueCertificate(GRADUATE_ID, { serial: 'OMZ-1' }, ACCOUNT_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.findBySerial).not.toHaveBeenCalled();
    });

    it('снимает выдачу и освобождает номер', async () => {
      repository.findById.mockResolvedValue(row({ certificateSerial: 'OMZ-2026-000148' }));

      await service.revokeCertificate(GRADUATE_ID);

      expect(repository.revokeCertificate).toHaveBeenCalledWith(GRADUATE_ID);
    });

    it('404 на снятие невыданного сертификата', async () => {
      await expect(service.revokeCertificate(GRADUATE_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repository.revokeCertificate).not.toHaveBeenCalled();
    });
  });

  describe('Автовыпуск', () => {
    it('выпускает действующий состав и закрывает членства одной транзакцией', async () => {
      const result = await service.graduateGroup(GROUP_ID);

      expect(repository.graduate).toHaveBeenCalledWith(
        GROUP_ID,
        [{ studentId: STUDENT_ID, points: 87.33, weeksCount: 12 }],
        [STUDENT_ID],
        new Date('2026-06-30T00:00:00.000Z'),
        GRADUATION_STATUS_REASON,
      );
      expect(result).toMatchObject({ groupId: GROUP_ID, graduated: 1 });
    });

    it('курс без «Is last course» никого не выпускает', async () => {
      repository.findGroupForGraduation.mockResolvedValue(
        group({ course: { id: COURSE_ID, title: 'Frontend Basic', isLastCourse: false } }),
      );

      expect(await service.graduateGroup(GROUP_ID)).toBeNull();
      expect(repository.findActiveMemberIds).not.toHaveBeenCalled();
      expect(repository.graduate).not.toHaveBeenCalled();
    });

    it('исчезнувшая группа не роняет вызов', async () => {
      repository.findGroupForGraduation.mockResolvedValue(null);

      expect(await service.graduateGroup(GROUP_ID)).toBeNull();
      expect(repository.graduate).not.toHaveBeenCalled();
    });

    it('группа без действующего состава выпуск не запускает', async () => {
      repository.findActiveMemberIds.mockResolvedValue([]);

      expect(await service.graduateGroup(GROUP_ID)).toBeNull();
      expect(repository.graduate).not.toHaveBeenCalled();
    });

    it('уже выпущенному второй строки не заводит, но членство закрывает', async () => {
      repository.findActiveMemberIds.mockResolvedValue([STUDENT_ID, OTHER_STUDENT_ID]);
      repository.findGraduatedStudentIds.mockResolvedValue([STUDENT_ID]);
      repository.findScores.mockResolvedValue([
        { studentId: OTHER_STUDENT_ID, average: 91, weeksCount: 4 },
      ]);

      const result = await service.graduateGroup(GROUP_ID);

      expect(repository.graduate).toHaveBeenCalledWith(
        GROUP_ID,
        [{ studentId: OTHER_STUDENT_ID, points: 91, weeksCount: 4 }],
        [STUDENT_ID, OTHER_STUDENT_ID],
        expect.any(Date),
        GRADUATION_STATUS_REASON,
      );
      expect(result?.graduated).toBe(1);
    });

    it('повторный выпуск уже выпущенной группы ничего не заводит', async () => {
      repository.findGraduatedStudentIds.mockResolvedValue([STUDENT_ID]);

      const result = await service.graduateGroup(GROUP_ID);

      expect(repository.graduate).toHaveBeenCalledWith(
        GROUP_ID,
        [],
        [STUDENT_ID],
        expect.any(Date),
        GRADUATION_STATUS_REASON,
      );
      expect(result?.graduated).toBe(0);
    });

    it('балл замораживается округлённым до двух знаков', async () => {
      repository.findScores.mockResolvedValue([
        { studentId: STUDENT_ID, average: 87.336_5, weeksCount: 3 },
      ]);

      await service.graduateGroup(GROUP_ID);

      expect(repository.graduate).toHaveBeenCalledWith(
        GROUP_ID,
        [{ studentId: STUDENT_ID, points: 87.34, weeksCount: 3 }],
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it('выпускник без закрытых недель получает null, а не ноль', async () => {
      repository.findScores.mockResolvedValue([]);

      await service.graduateGroup(GROUP_ID);

      expect(repository.graduate).toHaveBeenCalledWith(
        GROUP_ID,
        [{ studentId: STUDENT_ID, points: null, weeksCount: 0 }],
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it('без срока группы датой выпуска становится день закрытия', async () => {
      repository.findGroupForGraduation.mockResolvedValue(group({ endDate: null }));

      await service.graduateGroup(GROUP_ID);

      const graduatedAt = repository.graduate.mock.calls[0]?.[3];

      expect(graduatedAt?.getUTCHours()).toBe(0);
      expect(graduatedAt?.getTime()).toBeGreaterThan(new Date('2026-01-01').getTime());
    });

    it('пересчитывает статусы профилей всех, чьи членства закрыты', async () => {
      repository.findActiveMemberIds.mockResolvedValue([STUDENT_ID, OTHER_STUDENT_ID]);
      repository.findStudentsWithMemberships.mockResolvedValue([
        {
          id: STUDENT_ID,
          status: StudentStatus.ACTIVE,
          groups: [
            { status: 'FINISHED', statusChangedAt: new Date('2026-06-30T00:00:00.000Z') },
          ] as never,
        },
      ]);

      await service.graduateGroup(GROUP_ID);

      expect(repository.findStudentsWithMemberships).toHaveBeenCalledWith([
        STUDENT_ID,
        OTHER_STUDENT_ID,
      ]);
      expect(repository.setStudentStatuses).toHaveBeenCalledWith([
        { studentId: STUDENT_ID, status: StudentStatus.FINISHED },
      ]);
    });

    it('совпадающий статус профиля в БД не пишется', async () => {
      repository.findStudentsWithMemberships.mockResolvedValue([
        {
          id: STUDENT_ID,
          status: StudentStatus.FINISHED,
          groups: [
            { status: 'FINISHED', statusChangedAt: new Date('2026-06-30T00:00:00.000Z') },
          ] as never,
        },
      ]);

      await service.graduateGroup(GROUP_ID);

      expect(repository.setStudentStatuses).not.toHaveBeenCalled();
    });
  });
});
