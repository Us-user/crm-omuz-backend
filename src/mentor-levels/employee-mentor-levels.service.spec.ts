import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DirectoryStatus, Prisma } from '@prisma/client';

import { BusinessRuleException, SortOrder } from '../common';
import { MentorLevelHistoryQueryDto } from './dto';
import { EmployeeMentorLevelsService } from './employee-mentor-levels.service';
import type { MentorLevelHistoryRow, MentorLevelsRepository } from './mentor-levels.repository';

const EMPLOYEE_ID = '22222222-2222-2222-2222-222222222222';
const LEVEL_ID = '11111111-1111-1111-1111-111111111111';

const employee = { id: EMPLOYEE_ID, firstName: 'Фаррух', lastName: 'Раҳимов' };

const entry = (overrides: Partial<MentorLevelHistoryRow> = {}): MentorLevelHistoryRow => ({
  id: '33333333-3333-3333-3333-333333333333',
  employeeId: EMPLOYEE_ID,
  month: new Date('2026-09-01T00:00:00.000Z'),
  createdAt: new Date('2026-07-29T10:00:00.000Z'),
  level: {
    id: LEVEL_ID,
    name: 'Senior mentor',
    hourlyRate: new Prisma.Decimal('45.50'),
    status: DirectoryStatus.ACTIVE,
  },
  ...overrides,
});

const query = (overrides: Partial<MentorLevelHistoryQueryDto> = {}): MentorLevelHistoryQueryDto =>
  Object.assign(new MentorLevelHistoryQueryDto(), overrides);

describe('EmployeeMentorLevelsService', () => {
  let repository: jest.Mocked<
    Pick<
      MentorLevelsRepository,
      | 'findHistory'
      | 'findHistoryEntry'
      | 'setHistoryEntry'
      | 'deleteHistoryEntry'
      | 'findEmployee'
      | 'findLevel'
    >
  >;
  let service: EmployeeMentorLevelsService;

  beforeEach(() => {
    repository = {
      findHistory: jest.fn().mockResolvedValue({ rows: [entry()], total: 1 }),
      findHistoryEntry: jest.fn().mockResolvedValue(entry()),
      setHistoryEntry: jest.fn().mockImplementation(() => Promise.resolve(entry())),
      deleteHistoryEntry: jest.fn().mockResolvedValue(undefined),
      findEmployee: jest.fn().mockResolvedValue(employee),
      findLevel: jest
        .fn()
        .mockResolvedValue({ id: LEVEL_ID, name: 'Senior mentor', status: DirectoryStatus.ACTIVE }),
    };

    service = new EmployeeMentorLevelsService(repository as unknown as MentorLevelsRepository);
  });

  describe('История по месяцам', () => {
    it('отдаёт месяц как YYYY-MM — дня в столбце нет', async () => {
      const result = await service.findAll(EMPLOYEE_ID, query());

      expect(result.items[0]?.month).toBe('2026-09');
    });

    it('отдаёт ставку ступени числом рядом с месяцем: экран не догружает справочник', async () => {
      const result = await service.findAll(EMPLOYEE_ID, query());

      expect(result.items[0]?.level).toEqual({
        id: LEVEL_ID,
        name: 'Senior mentor',
        hourlyRate: 45.5,
        status: DirectoryStatus.ACTIVE,
      });
    });

    it('по умолчанию отдаёт свежие месяцы сверху', async () => {
      await service.findAll(EMPLOYEE_ID, query());

      expect(repository.findHistory).toHaveBeenCalledWith(
        expect.objectContaining({ order: SortOrder.Desc }),
      );
    });

    it('переводит фильтры from/to в первые числа месяцев', async () => {
      await service.findAll(
        EMPLOYEE_ID,
        query({ from: '2026-01', to: '2026-03', levelId: LEVEL_ID, page: 2, limit: 10 }),
      );

      expect(repository.findHistory).toHaveBeenCalledWith({
        employeeId: EMPLOYEE_ID,
        from: new Date('2026-01-01T00:00:00.000Z'),
        to: new Date('2026-03-01T00:00:00.000Z'),
        levelId: LEVEL_ID,
        order: SortOrder.Desc,
        skip: 10,
        take: 10,
      });
    });

    it('без периода границы до БД не доходят', async () => {
      await service.findAll(EMPLOYEE_ID, query());

      expect(repository.findHistory).toHaveBeenCalledWith(
        expect.objectContaining({ from: undefined, to: undefined }),
      );
    });

    it('400 на несуществующий месяц в фильтре', async () => {
      await expect(service.findAll(EMPLOYEE_ID, query({ from: '2026-13' }))).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('404 на неизвестного сотрудника — до запроса истории', async () => {
      repository.findEmployee.mockResolvedValue(null);

      await expect(service.findAll(EMPLOYEE_ID, query())).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.findHistory).not.toHaveBeenCalled();
    });
  });

  describe('Простановка уровня на месяц', () => {
    it('пишет запись первым числом месяца', async () => {
      await service.set(EMPLOYEE_ID, { month: '2026-09', levelId: LEVEL_ID });

      expect(repository.setHistoryEntry).toHaveBeenCalledWith(
        EMPLOYEE_ID,
        new Date('2026-09-01T00:00:00.000Z'),
        LEVEL_ID,
      );
    });

    it('идемпотентна: повторный запрос идёт тем же ключом «сотрудник + месяц»', async () => {
      await service.set(EMPLOYEE_ID, { month: '2026-09', levelId: LEVEL_ID });
      await service.set(EMPLOYEE_ID, { month: '2026-09', levelId: 'другой-уровень' });

      expect(repository.setHistoryEntry).toHaveBeenNthCalledWith(
        2,
        EMPLOYEE_ID,
        new Date('2026-09-01T00:00:00.000Z'),
        'другой-уровень',
      );
    });

    it('422 на несуществующую ступень — запись не пишется', async () => {
      repository.findLevel.mockResolvedValue(null);

      await expect(
        service.set(EMPLOYEE_ID, { month: '2026-09', levelId: LEVEL_ID }),
      ).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.setHistoryEntry).not.toHaveBeenCalled();
    });

    it('422 на ступень, выведенную из справочника', async () => {
      repository.findLevel.mockResolvedValue({
        id: LEVEL_ID,
        name: 'Старый уровень',
        status: DirectoryStatus.INACTIVE,
      });

      await expect(
        service.set(EMPLOYEE_ID, { month: '2026-09', levelId: LEVEL_ID }),
      ).rejects.toMatchObject({ message: expect.stringContaining('Старый уровень') as string });
      expect(repository.setHistoryEntry).not.toHaveBeenCalled();
    });

    it('позиция «Mentor» не спрашивается: уровень ставится любому сотруднику', async () => {
      await expect(
        service.set(EMPLOYEE_ID, { month: '2026-09', levelId: LEVEL_ID }),
      ).resolves.toBeDefined();
    });

    it('400 на несуществующий месяц — до поиска ступени', async () => {
      await expect(
        service.set(EMPLOYEE_ID, { month: '2026-13', levelId: LEVEL_ID }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.findLevel).not.toHaveBeenCalled();
    });

    it('404 на неизвестного сотрудника — до разбора тела', async () => {
      repository.findEmployee.mockResolvedValue(null);

      await expect(
        service.set(EMPLOYEE_ID, { month: '2026-09', levelId: LEVEL_ID }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.findLevel).not.toHaveBeenCalled();
      expect(repository.setHistoryEntry).not.toHaveBeenCalled();
    });
  });

  describe('Снятие уровня с месяца', () => {
    it('снимает запись и называет ступень, которая в ней стояла', async () => {
      const removed = await service.remove(EMPLOYEE_ID, '2026-09');

      expect(removed).toEqual({
        employeeId: EMPLOYEE_ID,
        month: '2026-09',
        levelName: 'Senior mentor',
      });
      expect(repository.deleteHistoryEntry).toHaveBeenCalledWith(
        EMPLOYEE_ID,
        new Date('2026-09-01T00:00:00.000Z'),
      );
    });

    it('404 на месяц без уровня — снятия не происходит', async () => {
      repository.findHistoryEntry.mockResolvedValue(null);

      await expect(service.remove(EMPLOYEE_ID, '2026-08')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repository.deleteHistoryEntry).not.toHaveBeenCalled();
    });

    it('сообщения про сотрудника и про месяц различимы', async () => {
      repository.findHistoryEntry.mockResolvedValue(null);
      await expect(service.remove(EMPLOYEE_ID, '2026-08')).rejects.toMatchObject({
        message: 'В этом месяце у сотрудника уровень не проставлен',
      });

      repository.findEmployee.mockResolvedValue(null);
      await expect(service.remove(EMPLOYEE_ID, '2026-08')).rejects.toMatchObject({
        message: 'Сотрудник не найден',
      });
    });

    it('400 на негодный месяц в пути', async () => {
      await expect(service.remove(EMPLOYEE_ID, 'сентябрь')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repository.findHistoryEntry).not.toHaveBeenCalled();
    });
  });
});
