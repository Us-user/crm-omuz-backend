import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { GroupStatus, WeekDay } from '@prisma/client';

import { BusinessRuleException, SortOrder } from '../common';
import { ScheduleSlotQueryDto, ScheduleSlotSortField } from './dto';
import type {
  GroupScheduleRepository,
  ScheduleSlotRow,
  SlotConflictRow,
  SlotGroup,
} from './group-schedule.repository';
import { GroupScheduleService } from './group-schedule.service';

const GROUP_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_GROUP_ID = '22222222-2222-2222-2222-222222222222';
const SLOT_ID = '33333333-3333-3333-3333-333333333333';
const ROOM_ID = '44444444-4444-4444-4444-444444444444';
const MENTOR_ID = '55555555-5555-5555-5555-555555555555';
const BRANCH_ID = '66666666-6666-6666-6666-666666666666';
const OTHER_BRANCH_ID = '77777777-7777-7777-7777-777777777777';

const group = (overrides: Partial<SlotGroup> = {}): SlotGroup => ({
  id: GROUP_ID,
  name: 'Frontend-1',
  branchId: BRANCH_ID,
  status: GroupStatus.ACTIVE,
  startDate: new Date('2026-09-01T00:00:00.000Z'),
  endDate: new Date('2026-09-30T00:00:00.000Z'),
  ...overrides,
});

const slotRow = (overrides: Partial<ScheduleSlotRow> = {}): ScheduleSlotRow => ({
  id: SLOT_ID,
  groupId: GROUP_ID,
  dayOfWeek: WeekDay.MONDAY,
  startMinute: 600,
  endMinute: 720,
  room: { id: ROOM_ID, name: '101' },
  mentor: { id: MENTOR_ID, firstName: 'Фаррух', lastName: 'Раҳимов', middleName: null },
  createdAt: new Date('2026-07-28T10:00:00.000Z'),
  ...overrides,
});

const conflict = (overrides: Partial<SlotConflictRow> = {}): SlotConflictRow => ({
  id: '88888888-8888-8888-8888-888888888888',
  groupId: OTHER_GROUP_ID,
  dayOfWeek: WeekDay.MONDAY,
  startMinute: 660,
  endMinute: 780,
  roomId: ROOM_ID,
  mentorId: null,
  group: group({ id: OTHER_GROUP_ID, name: 'Python-1' }),
  ...overrides,
});

// Настоящий экземпляр DTO, а не литерал: `skip`/`take` — вычисляемые геттеры,
// и подделанные значения скрыли бы ошибку в переводе страницы в окно выборки.
const query = (overrides: Partial<ScheduleSlotQueryDto> = {}): ScheduleSlotQueryDto =>
  Object.assign(new ScheduleSlotQueryDto(), overrides);

describe('GroupScheduleService', () => {
  let repository: jest.Mocked<
    Pick<
      GroupScheduleRepository,
      | 'findMany'
      | 'findGroup'
      | 'findRoom'
      | 'findGroupMentor'
      | 'findOne'
      | 'findOverlapping'
      | 'create'
      | 'update'
      | 'delete'
    >
  >;
  let service: GroupScheduleService;

  beforeEach(() => {
    repository = {
      findMany: jest.fn().mockResolvedValue({ rows: [slotRow()], total: 1 }),
      findGroup: jest.fn().mockResolvedValue(group()),
      findRoom: jest.fn().mockResolvedValue({ id: ROOM_ID, name: '101', branchId: BRANCH_ID }),
      findGroupMentor: jest.fn().mockResolvedValue({
        employee: { id: MENTOR_ID, firstName: 'Фаррух', lastName: 'Раҳимов' },
      }),
      findOne: jest.fn().mockResolvedValue(slotRow()),
      findOverlapping: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(() => Promise.resolve(slotRow())),
      update: jest.fn().mockImplementation(() => Promise.resolve(slotRow())),
      delete: jest.fn().mockResolvedValue(undefined),
    };

    service = new GroupScheduleService(repository as unknown as GroupScheduleRepository);
  });

  describe('Расписание группы', () => {
    it('отдаёт занятие временем «HH:MM», а не минутами', async () => {
      const result = await service.findAll(GROUP_ID, query());

      expect(result.meta).toMatchObject({ total: 1, page: 1, limit: 20 });
      expect(result.items[0]).toMatchObject({
        id: SLOT_ID,
        groupId: GROUP_ID,
        dayOfWeek: WeekDay.MONDAY,
        startTime: '10:00',
        endTime: '12:00',
        room: { id: ROOM_ID, name: '101' },
        mentor: { id: MENTOR_ID, lastName: 'Раҳимов' },
      });
    });

    it('передаёт репозиторию окно страницы и все фильтры', async () => {
      await service.findAll(
        GROUP_ID,
        query({
          page: 3,
          limit: 5,
          dayOfWeek: WeekDay.FRIDAY,
          roomId: ROOM_ID,
          mentorId: MENTOR_ID,
          search: '101',
          sort: ScheduleSlotSortField.StartTime,
          order: SortOrder.Desc,
        }),
      );

      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          groupId: GROUP_ID,
          skip: 10,
          take: 5,
          dayOfWeek: WeekDay.FRIDAY,
          roomId: ROOM_ID,
          mentorId: MENTOR_ID,
          search: '101',
          sort: ScheduleSlotSortField.StartTime,
          order: SortOrder.Desc,
        }),
      );
    });

    it('по умолчанию читается по дням недели с начала недели', async () => {
      await service.findAll(GROUP_ID, query());

      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ sort: ScheduleSlotSortField.DayOfWeek, order: SortOrder.Asc }),
      );
    });

    it('неизвестная группа — 404, расписание не запрашивается', async () => {
      repository.findGroup.mockResolvedValue(null);

      await expect(service.findAll(GROUP_ID, query())).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.findMany).not.toHaveBeenCalled();
    });
  });

  describe('Добавление занятия (ТЗ 5.5)', () => {
    const dto = {
      dayOfWeek: WeekDay.MONDAY,
      startTime: '10:00',
      endTime: '12:00',
      roomId: ROOM_ID,
      mentorId: MENTOR_ID,
    };

    it('переводит время в минуты от полуночи', async () => {
      await service.create(GROUP_ID, { ...dto, startTime: '09:30', endTime: '11:45' });

      expect(repository.create).toHaveBeenCalledWith({
        groupId: GROUP_ID,
        dayOfWeek: WeekDay.MONDAY,
        startMinute: 570,
        endMinute: 705,
        roomId: ROOM_ID,
        mentorId: MENTOR_ID,
      });
    });

    it('занятие без аудитории и ментора допустимо (группа онлайн)', async () => {
      await service.create(GROUP_ID, {
        dayOfWeek: WeekDay.TUESDAY,
        startTime: '18:00',
        endTime: '20:00',
      });

      expect(repository.findRoom).not.toHaveBeenCalled();
      expect(repository.findGroupMentor).not.toHaveBeenCalled();
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ roomId: null, mentorId: null }),
      );
    });

    it('неизвестная группа — 404, аудиторию не ищем', async () => {
      repository.findGroup.mockResolvedValue(null);

      await expect(service.create(GROUP_ID, dto)).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.findRoom).not.toHaveBeenCalled();
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('несуществующая аудитория — 422, занятие не создаётся', async () => {
      repository.findRoom.mockResolvedValue(null);

      await expect(service.create(GROUP_ID, dto)).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('аудитория чужого филиала — 422 (правило обещано сессией 0008)', async () => {
      repository.findRoom.mockResolvedValue({
        id: ROOM_ID,
        name: '101',
        branchId: OTHER_BRANCH_ID,
      });

      await expect(service.create(GROUP_ID, dto)).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('сотрудник не из менторов группы — 422', async () => {
      repository.findGroupMentor.mockResolvedValue(null);

      await expect(service.create(GROUP_ID, dto)).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.findGroupMentor).toHaveBeenCalledWith(GROUP_ID, MENTOR_ID);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('окончание раньше начала — 400', async () => {
      await expect(
        service.create(GROUP_ID, { ...dto, startTime: '12:00', endTime: '10:00' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('занятие нулевой длины — 400', async () => {
      await expect(
        service.create(GROUP_ID, { ...dto, startTime: '10:00', endTime: '10:00' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('ищет пересечения по дню недели и окну времени', async () => {
      await service.create(GROUP_ID, dto);

      expect(repository.findOverlapping).toHaveBeenCalledWith({
        dayOfWeek: WeekDay.MONDAY,
        startMinute: 600,
        endMinute: 720,
        groupId: GROUP_ID,
        roomId: ROOM_ID,
        mentorId: MENTOR_ID,
      });
    });

    it('занятие онлайн аудиторию в пересечениях не ищет', async () => {
      await service.create(GROUP_ID, {
        dayOfWeek: WeekDay.MONDAY,
        startTime: '10:00',
        endTime: '12:00',
      });

      expect(repository.findOverlapping).toHaveBeenCalledWith(
        expect.not.objectContaining({ roomId: expect.anything() as string }),
      );
    });

    it('у группы уже есть занятие в это время — 409', async () => {
      repository.findOverlapping.mockResolvedValue([
        conflict({ groupId: GROUP_ID, group: group(), roomId: null }),
      ]);

      await expect(service.create(GROUP_ID, dto)).rejects.toThrow(ConflictException);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('аудитория занята другой группой — 409 с её названием', async () => {
      repository.findOverlapping.mockResolvedValue([conflict()]);

      await expect(service.create(GROUP_ID, dto)).rejects.toThrow(/Python-1/);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('ментор в это время ведёт другую группу — 409', async () => {
      repository.findOverlapping.mockResolvedValue([
        conflict({ roomId: null, mentorId: MENTOR_ID }),
      ]);

      await expect(service.create(GROUP_ID, dto)).rejects.toThrow(/ведёт занятие/);
    });

    it('занятия завершённой группы аудиторию не занимают', async () => {
      repository.findOverlapping.mockResolvedValue([
        conflict({ group: group({ id: OTHER_GROUP_ID, status: GroupStatus.FINISHED }) }),
      ]);

      await expect(service.create(GROUP_ID, dto)).resolves.toBeDefined();
    });

    it('занятия несостоявшейся группы аудиторию не занимают', async () => {
      repository.findOverlapping.mockResolvedValue([
        conflict({ group: group({ id: OTHER_GROUP_ID, status: GroupStatus.CANCELLED }) }),
      ]);

      await expect(service.create(GROUP_ID, dto)).resolves.toBeDefined();
    });

    it('группа, отучившаяся до нашего набора, аудиторию не занимает', async () => {
      repository.findOverlapping.mockResolvedValue([
        conflict({
          group: group({
            id: OTHER_GROUP_ID,
            startDate: new Date('2026-06-01T00:00:00.000Z'),
            endDate: new Date('2026-06-30T00:00:00.000Z'),
          }),
        }),
      ]);

      await expect(service.create(GROUP_ID, dto)).resolves.toBeDefined();
    });

    it('группа с открытым сроком считается пересекающейся — 409', async () => {
      repository.findOverlapping.mockResolvedValue([
        conflict({
          group: group({ id: OTHER_GROUP_ID, name: 'Python-1', startDate: null, endDate: null }),
        }),
      ]);

      await expect(service.create(GROUP_ID, dto)).rejects.toThrow(ConflictException);
    });

    it('своё занятие конфликтует даже у завершённой группы', async () => {
      repository.findGroup.mockResolvedValue(group({ status: GroupStatus.FINISHED }));
      repository.findOverlapping.mockResolvedValue([
        conflict({ groupId: GROUP_ID, group: group({ status: GroupStatus.FINISHED }) }),
      ]);

      await expect(service.create(GROUP_ID, dto)).rejects.toThrow(/У группы уже есть занятие/);
    });

    it('завершённая группа чужую аудиторию не оспаривает', async () => {
      repository.findGroup.mockResolvedValue(group({ status: GroupStatus.FINISHED }));
      repository.findOverlapping.mockResolvedValue([conflict()]);

      await expect(service.create(GROUP_ID, dto)).resolves.toBeDefined();
    });
  });

  describe('Правка занятия', () => {
    it('меняет день и время, проверяя итоговое состояние', async () => {
      await service.update(GROUP_ID, SLOT_ID, {
        dayOfWeek: WeekDay.WEDNESDAY,
        startTime: '11:00',
      });

      expect(repository.findOverlapping).toHaveBeenCalledWith(
        expect.objectContaining({
          dayOfWeek: WeekDay.WEDNESDAY,
          startMinute: 660,
          // Окончание не передавали — берётся из БД.
          endMinute: 720,
          exceptSlotId: SLOT_ID,
        }),
      );
    });

    it('не переданные поля до БД не доходят', async () => {
      await service.update(GROUP_ID, SLOT_ID, { dayOfWeek: WeekDay.FRIDAY });

      expect(repository.update).toHaveBeenCalledWith(SLOT_ID, {
        dayOfWeek: WeekDay.FRIDAY,
        startMinute: undefined,
        endMinute: undefined,
        roomId: undefined,
        mentorId: undefined,
      });
    });

    it('пустая строка снимает аудиторию', async () => {
      await service.update(GROUP_ID, SLOT_ID, { roomId: '' });

      expect(repository.findRoom).not.toHaveBeenCalled();
      expect(repository.update).toHaveBeenCalledWith(
        SLOT_ID,
        expect.objectContaining({ roomId: null }),
      );
    });

    it('пустая строка снимает ментора', async () => {
      await service.update(GROUP_ID, SLOT_ID, { mentorId: '' });

      expect(repository.findGroupMentor).not.toHaveBeenCalled();
      expect(repository.update).toHaveBeenCalledWith(
        SLOT_ID,
        expect.objectContaining({ mentorId: null }),
      );
    });

    it('та же аудитория лишней проверки не вызывает', async () => {
      await service.update(GROUP_ID, SLOT_ID, { roomId: ROOM_ID });

      expect(repository.findRoom).not.toHaveBeenCalled();
    });

    it('новая аудитория чужого филиала — 422, слот не меняется', async () => {
      repository.findRoom.mockResolvedValue({
        id: 'other-room',
        name: '202',
        branchId: OTHER_BRANCH_ID,
      });

      await expect(
        service.update(GROUP_ID, SLOT_ID, { roomId: '99999999-9999-9999-9999-999999999999' }),
      ).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('новое окончание сверяется с началом из БД — 400', async () => {
      await expect(service.update(GROUP_ID, SLOT_ID, { endTime: '09:00' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('новое начало сверяется с окончанием из БД — 400', async () => {
      await expect(
        service.update(GROUP_ID, SLOT_ID, { startTime: '14:00' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('сам с собой слот не конфликтует', async () => {
      await service.update(GROUP_ID, SLOT_ID, { startTime: '10:30' });

      expect(repository.findOverlapping).toHaveBeenCalledWith(
        expect.objectContaining({ exceptSlotId: SLOT_ID }),
      );
    });

    it('пересечение при правке — 409, слот не меняется', async () => {
      repository.findOverlapping.mockResolvedValue([conflict()]);

      await expect(
        service.update(GROUP_ID, SLOT_ID, { startTime: '11:00' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('занятие чужой группы — 404', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(
        service.update(GROUP_ID, SLOT_ID, { startTime: '11:00' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('сообщения про группу и про занятие различимы', async () => {
      repository.findGroup.mockResolvedValue(null);
      await expect(service.update(GROUP_ID, SLOT_ID, {})).rejects.toThrow(/Группа не найдена/);

      repository.findGroup.mockResolvedValue(group());
      repository.findOne.mockResolvedValue(null);
      await expect(service.update(GROUP_ID, SLOT_ID, {})).rejects.toThrow(/Занятие не найдено/);
    });
  });

  describe('Удаление занятия', () => {
    it('называет убранное занятие', async () => {
      const result = await service.remove(GROUP_ID, SLOT_ID);

      expect(result).toEqual({
        id: SLOT_ID,
        groupId: GROUP_ID,
        dayOfWeek: WeekDay.MONDAY,
        startTime: '10:00',
        endTime: '12:00',
      });
      expect(repository.delete).toHaveBeenCalledWith(SLOT_ID);
    });

    it('занятие чужой группы — 404, ничего не удаляется', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.remove(GROUP_ID, SLOT_ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.delete).not.toHaveBeenCalled();
    });
  });
});
