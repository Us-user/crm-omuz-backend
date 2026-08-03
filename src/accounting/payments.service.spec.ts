import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DirectoryStatus, GroupStatus } from '@prisma/client';

import { BusinessRuleException } from '../common';
import { ChargeStatus } from './accounting';
import type {
  AccountingRepository,
  ChargeableGroup,
  ChargeRow,
  TransactionRow,
} from './accounting.repository';
import { ChargesQueryDto, TransactionsQueryDto } from './dto';
import { PeriodGuardService } from './period-guard.service';
import { PaymentsService } from './payments.service';
import { PdfGeneratorService } from '../documents/pdf-generator.service';
import { DocxGeneratorService } from '../documents/docx-generator.service';

const CHARGE_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_CHARGE_ID = '1a1a1a1a-1111-1111-1111-111111111111';
const STUDENT_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_STUDENT_ID = '2b2b2b2b-2222-2222-2222-222222222222';
const GROUP_ID = '33333333-3333-3333-3333-333333333333';
const COURSE_ID = '44444444-4444-4444-4444-444444444444';
const BRANCH_ID = '55555555-5555-5555-5555-555555555555';
const ACCOUNT_ID = '66666666-6666-6666-6666-666666666666';
const EMPLOYEE_ID = '77777777-7777-7777-7777-777777777777';
const TRANSACTION_ID = '88888888-8888-8888-8888-888888888888';
const TYPE_ID = '99999999-9999-9999-9999-999999999999';

const SEPTEMBER = new Date('2026-09-01T00:00:00.000Z');

const charge = (overrides: Partial<ChargeRow> = {}): ChargeRow => ({
  id: CHARGE_ID,
  month: SEPTEMBER,
  amount: '1200.00' as unknown as ChargeRow['amount'],
  discount: '0.00' as unknown as ChargeRow['discount'],
  discountReason: null,
  paidAmount: '0.00' as unknown as ChargeRow['paidAmount'],
  remainingAmount: '1200.00' as unknown as ChargeRow['remainingAmount'],
  note: null,
  createdAt: new Date('2026-09-01T08:00:00.000Z'),
  student: {
    id: STUDENT_ID,
    firstName: 'Нилуфар',
    lastName: 'Каримова',
    phone: '+992901234567',
  },
  group: {
    id: GROUP_ID,
    name: 'Frontend-1',
    course: { id: COURSE_ID, title: 'Frontend Pro' },
    branch: { id: BRANCH_ID, name: 'Sadbarg' },
  },
  createdBy: null,
  ...overrides,
});

const transaction = (overrides: Partial<TransactionRow> = {}): TransactionRow => ({
  id: TRANSACTION_ID,
  amount: '600.00' as unknown as TransactionRow['amount'],
  paidAt: new Date('2026-09-05T00:00:00.000Z'),
  comment: null,
  editReason: null,
  editedAt: null,
  createdAt: new Date('2026-09-05T10:00:00.000Z'),
  student: {
    id: STUDENT_ID,
    firstName: 'Нилуфар',
    lastName: 'Каримова',
    phone: '+992901234567',
  },
  charge: { id: CHARGE_ID, month: SEPTEMBER, group: { id: GROUP_ID, name: 'Frontend-1' } },
  type: null,
  createdBy: null,
  editedBy: null,
  ...overrides,
});

const chargeableGroup = (overrides: Partial<ChargeableGroup> = {}): ChargeableGroup => ({
  id: GROUP_ID,
  name: 'Frontend-1',
  status: GroupStatus.ACTIVE,
  course: { id: COURSE_ID, title: 'Frontend Pro', fee: '1200.00' as unknown as never },
  students: [{ studentId: STUDENT_ID }],
  ...overrides,
});

// Настоящий экземпляр DTO, а не литерал: `skip`/`take` — вычисляемые геттеры
// (ловушка `IntersectionType` из сессии 0025).
const chargesQuery = (overrides: Partial<ChargesQueryDto> = {}): ChargesQueryDto =>
  Object.assign(new ChargesQueryDto(), overrides);

const transactionsQuery = (overrides: Partial<TransactionsQueryDto> = {}): TransactionsQueryDto =>
  Object.assign(new TransactionsQueryDto(), overrides);

describe('PaymentsService', () => {
  let repository: jest.Mocked<
    Pick<
      AccountingRepository,
      | 'findManyCharges'
      | 'aggregateCharges'
      | 'findChargeById'
      | 'findChargeCard'
      | 'countChargeTransactions'
      | 'findGroupById'
      | 'findChargeableGroups'
      | 'findExistingChargeKeys'
      | 'createCharges'
      | 'updateCharge'
      | 'deleteCharge'
      | 'findManyTransactions'
      | 'findTransactionById'
      | 'createTransaction'
      | 'updateTransaction'
      | 'deleteTransaction'
      | 'findTypeById'
      | 'findStudentById'
      | 'findEmployeeByAccount'
      | 'findArchivedPeriodForMonth'
    >
  >;
  let service: PaymentsService;

  beforeEach(() => {
    repository = {
      findManyCharges: jest.fn().mockResolvedValue({ rows: [charge()], total: 1 }),
      aggregateCharges: jest.fn().mockResolvedValue({ chargedCents: 120000, paidCents: 0 }),
      findChargeById: jest.fn().mockResolvedValue(charge()),
      findChargeCard: jest.fn().mockResolvedValue({ charge: charge(), transactions: [] }),
      countChargeTransactions: jest.fn().mockResolvedValue(0),
      findGroupById: jest
        .fn()
        .mockResolvedValue({ id: GROUP_ID, name: 'Frontend-1', status: GroupStatus.ACTIVE }),
      findChargeableGroups: jest.fn().mockResolvedValue([chargeableGroup()]),
      findExistingChargeKeys: jest.fn().mockResolvedValue(new Set<string>()),
      createCharges: jest.fn().mockResolvedValue([charge()]),
      updateCharge: jest.fn().mockResolvedValue(charge()),
      deleteCharge: jest.fn().mockResolvedValue(undefined),
      findManyTransactions: jest
        .fn()
        .mockResolvedValue({ rows: [transaction()], total: 1, sumCents: 60000 }),
      findTransactionById: jest.fn().mockResolvedValue(transaction()),
      createTransaction: jest.fn().mockResolvedValue(transaction()),
      updateTransaction: jest.fn().mockResolvedValue(transaction()),
      deleteTransaction: jest.fn().mockResolvedValue(undefined),
      findTypeById: jest.fn().mockResolvedValue({
        id: TYPE_ID,
        name: 'Alif',
        description: null,
        status: DirectoryStatus.ACTIVE,
        createdAt: new Date(),
        _count: { transactions: 0 },
      }),
      findStudentById: jest
        .fn()
        .mockResolvedValue({ id: STUDENT_ID, firstName: 'Нилуфар', lastName: 'Каримова' }),
      findEmployeeByAccount: jest.fn().mockResolvedValue({ id: EMPLOYEE_ID }),
      findArchivedPeriodForMonth: jest.fn().mockResolvedValue(null),
    };

    service = new PaymentsService(
      repository as unknown as AccountingRepository,
      new PeriodGuardService(repository as unknown as AccountingRepository),
      new PdfGeneratorService(),
      new DocxGeneratorService(),
    );
  });

  describe('начисление месяца', () => {
    it('заводит месяц действующему составу по стоимости курса', async () => {
      const result = await service.chargeMonth({ month: '2026-09' }, ACCOUNT_ID);

      expect(repository.createCharges).toHaveBeenCalledWith(
        SEPTEMBER,
        [{ studentId: STUDENT_ID, groupId: GROUP_ID, amountCents: 120000 }],
        EMPLOYEE_ID,
      );
      expect(result).toMatchObject({ month: '2026-09', created: 1, skipped: 0 });
    });

    it('пропускает уже начисленные пары «студент + группа»', async () => {
      repository.findExistingChargeKeys.mockResolvedValue(new Set([`${GROUP_ID}:${STUDENT_ID}`]));

      const result = await service.chargeMonth({ month: '2026-09' }, ACCOUNT_ID);

      expect(repository.createCharges).toHaveBeenCalledWith(SEPTEMBER, [], EMPLOYEE_ID);
      expect(result).toMatchObject({ skipped: 1 });
    });

    it('без `groupId` группу отдельно не проверяет', async () => {
      await service.chargeMonth({ month: '2026-09' }, ACCOUNT_ID);

      expect(repository.findGroupById).not.toHaveBeenCalled();
      expect(repository.findChargeableGroups).toHaveBeenCalledWith(undefined);
    });

    it('422 на несуществующую группу — до выборки состава', async () => {
      repository.findGroupById.mockResolvedValue(null);

      await expect(
        service.chargeMonth({ month: '2026-09', groupId: GROUP_ID }, ACCOUNT_ID),
      ).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.findChargeableGroups).not.toHaveBeenCalled();
    });

    it('422 на отменённую группу: набор не состоялся — начислять нечего', async () => {
      repository.findGroupById.mockResolvedValue({
        id: GROUP_ID,
        name: 'Frontend-1',
        status: GroupStatus.CANCELLED,
      });

      await expect(
        service.chargeMonth({ month: '2026-09', groupId: GROUP_ID }, ACCOUNT_ID),
      ).rejects.toThrow(/отменена/);
      expect(repository.createCharges).not.toHaveBeenCalled();
    });

    it('400 на негодный месяц — до всех запросов', async () => {
      await expect(service.chargeMonth({ month: '2026-13' }, ACCOUNT_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repository.findChargeableGroups).not.toHaveBeenCalled();
    });

    it('группа без действующего состава ничего не заводит', async () => {
      repository.findChargeableGroups.mockResolvedValue([chargeableGroup({ students: [] })]);
      repository.createCharges.mockResolvedValue([]);

      const result = await service.chargeMonth({ month: '2026-09' }, ACCOUNT_ID);

      expect(result).toMatchObject({ created: 0, skipped: 0 });
    });

    it('аккаунт без профиля сотрудника подписи не оставляет', async () => {
      repository.findEmployeeByAccount.mockResolvedValue(null);

      await service.chargeMonth({ month: '2026-09' }, ACCOUNT_ID);

      expect(repository.createCharges).toHaveBeenCalledWith(SEPTEMBER, expect.anything(), null);
    });
  });

  describe('список начислений', () => {
    it('отдаёт статус и остаток, посчитанные из сумм', async () => {
      repository.findManyCharges.mockResolvedValue({
        rows: [
          charge({
            discount: '200.00' as unknown as ChargeRow['discount'],
            paidAmount: '400.00' as unknown as ChargeRow['paidAmount'],
          }),
        ],
        total: 1,
      });

      const { items } = await service.findAllCharges(chargesQuery());

      expect(items[0]).toMatchObject({
        amount: 1200,
        discount: 200,
        due: 1000,
        paid: 400,
        remaining: 600,
        status: ChargeStatus.Partial,
        statusTitle: 'Оплачен частично',
        month: '2026-09',
      });
    });

    it('итоги считаются по всему набору и уходят в `meta`', async () => {
      repository.aggregateCharges.mockResolvedValue({ chargedCents: 2400000, paidCents: 1800000 });

      const { meta } = await service.findAllCharges(chargesQuery());

      expect(meta).toMatchObject({ totals: { charged: 24000, paid: 18000, debt: 6000 } });
    });

    it('передаёт окно страницы и доменные фильтры, а период — отрезком месяцев', async () => {
      await service.findAllCharges(
        chargesQuery({
          page: 2,
          limit: 20,
          groupId: GROUP_ID,
          status: ChargeStatus.NotPaid,
          from: '2026-08',
          to: '2026-09',
        }),
      );

      expect(repository.findManyCharges).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 20,
          take: 20,
          groupId: GROUP_ID,
          status: ChargeStatus.NotPaid,
          from: new Date('2026-08-01T00:00:00.000Z'),
          // Правая граница не включающая — первое число следующего месяца.
          to: new Date('2026-10-01T00:00:00.000Z'),
        }),
      );
    });

    it('без периода границы до БД не доходят', async () => {
      await service.findAllCharges(chargesQuery());

      expect(repository.findManyCharges).toHaveBeenCalledWith(
        expect.objectContaining({ from: undefined, to: undefined }),
      );
    });

    it('400 на негодный месяц в фильтре — до запроса', async () => {
      await expect(service.findAllCharges(chargesQuery({ from: '2026-9' }))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repository.findManyCharges).not.toHaveBeenCalled();
    });
  });

  describe('карточка начисления', () => {
    it('считает принятую сумму по самим платежам', async () => {
      repository.findChargeCard.mockResolvedValue({
        charge: charge({ paidAmount: '600.00' as unknown as ChargeRow['paidAmount'] }),
        transactions: [transaction(), transaction({ id: OTHER_CHARGE_ID })],
      });

      const card = await service.findCharge(CHARGE_ID);

      // В колонке 600, по платежам 1200 — наружу уходит пересчитанное.
      expect(card).toMatchObject({ paid: 1200, remaining: 0, status: ChargeStatus.Paid });
      expect(card.transactions).toHaveLength(2);
    });

    it('404 на неизвестное начисление', async () => {
      repository.findChargeCard.mockResolvedValue(null);

      await expect(service.findCharge(CHARGE_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('скидка на месяц', () => {
    it('сохраняет скидку с причиной', async () => {
      await service.updateCharge(CHARGE_ID, { discount: 200, discountReason: 'Второй ребёнок' });

      expect(repository.updateCharge).toHaveBeenCalledWith(CHARGE_ID, {
        discountCents: 20000,
        discountReason: 'Второй ребёнок',
        note: undefined,
      });
    });

    it('400 на скидку больше начисленного', async () => {
      await expect(
        service.updateCharge(CHARGE_ID, { discount: 1500, discountReason: 'Ошибка' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.updateCharge).not.toHaveBeenCalled();
    });

    it('400 на ненулевую скидку без причины', async () => {
      await expect(service.updateCharge(CHARGE_ID, { discount: 200 })).rejects.toThrow(
        /без причины/,
      );
    });

    it('причина из БД считается заданной — повторять её в запросе не нужно', async () => {
      repository.findChargeById.mockResolvedValue(charge({ discountReason: 'Второй ребёнок' }));

      await service.updateCharge(CHARGE_ID, { discount: 300 });

      expect(repository.updateCharge).toHaveBeenCalled();
    });

    it('нулевая скидка причины не требует', async () => {
      await service.updateCharge(CHARGE_ID, { discount: 0 });

      expect(repository.updateCharge).toHaveBeenCalled();
    });

    it('422 на скидку ниже уже принятых денег', async () => {
      repository.findChargeById.mockResolvedValue(
        charge({ paidAmount: '900.00' as unknown as ChargeRow['paidAmount'] }),
      );

      await expect(
        service.updateCharge(CHARGE_ID, { discount: 500, discountReason: 'Пересчёт' }),
      ).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.updateCharge).not.toHaveBeenCalled();
    });

    it('пустая строка очищает причину и примечание', async () => {
      await service.updateCharge(CHARGE_ID, { discountReason: '', note: '' });

      expect(repository.updateCharge).toHaveBeenCalledWith(CHARGE_ID, {
        discountCents: undefined,
        discountReason: null,
        note: null,
      });
    });

    it('404 до записи', async () => {
      repository.findChargeById.mockResolvedValue(null);

      await expect(service.updateCharge(CHARGE_ID, { note: 'x' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repository.updateCharge).not.toHaveBeenCalled();
    });
  });

  describe('удаление начисления', () => {
    it('удаляет месяц без платежей', async () => {
      const result = await service.removeCharge(CHARGE_ID, { reason: 'Ошибочно начислено' });

      expect(repository.deleteCharge).toHaveBeenCalledWith(CHARGE_ID);
      expect(result.title).toContain('Frontend-1');
    });

    it('409 на месяц с принятыми платежами', async () => {
      repository.countChargeTransactions.mockResolvedValue(2);

      await expect(
        service.removeCharge(CHARGE_ID, { reason: 'Ошибочно начислено' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repository.deleteCharge).not.toHaveBeenCalled();
    });
  });

  describe('приём оплаты', () => {
    it('принимает деньги по месяцу от того студента, которому он начислен', async () => {
      await service.pay({ chargeId: CHARGE_ID, amount: 600, paidAt: '2026-09-05' }, ACCOUNT_ID);

      expect(repository.createTransaction).toHaveBeenCalledWith({
        studentId: STUDENT_ID,
        chargeId: CHARGE_ID,
        amountCents: 60000,
        paidAt: new Date('2026-09-05T00:00:00.000Z'),
        typeId: null,
        comment: null,
        createdById: EMPLOYEE_ID,
      });
    });

    it('день получения денег по умолчанию — сегодня, без времени', async () => {
      await service.pay({ chargeId: CHARGE_ID, amount: 600 }, ACCOUNT_ID);

      const [input] = repository.createTransaction.mock.calls[0];
      const now = new Date();

      expect(input.paidAt).toEqual(
        new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
      );
    });

    it('422 на несуществующее начисление', async () => {
      repository.findChargeById.mockResolvedValue(null);

      await expect(
        service.pay({ chargeId: CHARGE_ID, amount: 600 }, ACCOUNT_ID),
      ).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.createTransaction).not.toHaveBeenCalled();
    });

    it('422 на сумму больше остатка — переплата оформляется предоплатой', async () => {
      repository.findChargeById.mockResolvedValue(
        charge({ paidAmount: '1000.00' as unknown as ChargeRow['paidAmount'] }),
      );

      await expect(service.pay({ chargeId: CHARGE_ID, amount: 300 }, ACCOUNT_ID)).rejects.toThrow(
        /остатка по месяцу \(200 TJS\)/,
      );
      expect(repository.createTransaction).not.toHaveBeenCalled();
    });

    it('422 на закрытый месяц', async () => {
      repository.findChargeById.mockResolvedValue(
        charge({ paidAmount: '1200.00' as unknown as ChargeRow['paidAmount'] }),
      );

      await expect(service.pay({ chargeId: CHARGE_ID, amount: 100 }, ACCOUNT_ID)).rejects.toThrow(
        /уже закрыт/,
      );
    });

    it('скидка увеличивает то, что месяц считает закрытым', async () => {
      repository.findChargeById.mockResolvedValue(
        charge({
          discount: '200.00' as unknown as ChargeRow['discount'],
          paidAmount: '1000.00' as unknown as ChargeRow['paidAmount'],
        }),
      );

      await expect(service.pay({ chargeId: CHARGE_ID, amount: 1 }, ACCOUNT_ID)).rejects.toThrow(
        /уже закрыт/,
      );
    });

    it('422 на несуществующий способ оплаты', async () => {
      repository.findTypeById.mockResolvedValue(null);

      await expect(
        service.pay({ chargeId: CHARGE_ID, amount: 600, typeId: TYPE_ID }, ACCOUNT_ID),
      ).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.createTransaction).not.toHaveBeenCalled();
    });

    it('422 на выведенный из работы способ оплаты', async () => {
      repository.findTypeById.mockResolvedValue({
        id: TYPE_ID,
        name: 'Старый терминал',
        description: null,
        status: DirectoryStatus.INACTIVE,
        createdAt: new Date(),
        _count: { transactions: 3, salaryTransactions: 0 },
      });

      await expect(
        service.pay({ chargeId: CHARGE_ID, amount: 600, typeId: TYPE_ID }, ACCOUNT_ID),
      ).rejects.toThrow(/выведен из работы/);
    });

    it('без способа оплаты справочник не спрашивается', async () => {
      await service.pay({ chargeId: CHARGE_ID, amount: 600 }, ACCOUNT_ID);

      expect(repository.findTypeById).not.toHaveBeenCalled();
    });
  });

  describe('предоплата', () => {
    it('заводит платёж без месяца', async () => {
      repository.createTransaction.mockResolvedValue(transaction({ charge: null }));

      const result = await service.prepay({ studentId: STUDENT_ID, amount: 1200 }, ACCOUNT_ID);

      expect(repository.createTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ studentId: STUDENT_ID, chargeId: null, amountCents: 120000 }),
      );
      expect(result).toMatchObject({ prepayment: true, charge: null });
    });

    it('422 на несуществующего студента', async () => {
      repository.findStudentById.mockResolvedValue(null);

      await expect(
        service.prepay({ studentId: STUDENT_ID, amount: 1200 }, ACCOUNT_ID),
      ).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.createTransaction).not.toHaveBeenCalled();
    });
  });

  describe('история платежей', () => {
    it('сумма набора уходит в `meta`, а предоплата помечена', async () => {
      repository.findManyTransactions.mockResolvedValue({
        rows: [transaction({ charge: null })],
        total: 1,
        sumCents: 120000,
      });

      const result = await service.findAllTransactions(transactionsQuery());

      expect(result.meta).toMatchObject({ totalAmount: 1200 });
      expect(result.items[0]).toMatchObject({ prepayment: true, paidAt: '2026-09-05' });
    });

    it('передаёт фильтр предоплат и период получения денег', async () => {
      await service.findAllTransactions(transactionsQuery({ prepayment: true, from: '2026-09' }));

      expect(repository.findManyTransactions).toHaveBeenCalledWith(
        expect.objectContaining({
          prepayment: true,
          from: new Date('2026-09-01T00:00:00.000Z'),
        }),
      );
    });
  });

  describe('правка платежа', () => {
    it('пишет причину и автора правки', async () => {
      await service.updateTransaction(TRANSACTION_ID, { reason: 'Ошибка в чеке' }, ACCOUNT_ID);

      expect(repository.updateTransaction).toHaveBeenCalledWith(
        TRANSACTION_ID,
        expect.objectContaining({ editReason: 'Ошибка в чеке', editedById: EMPLOYEE_ID }),
        [CHARGE_ID],
      );
    });

    it('разносит предоплату по месяцу того же студента', async () => {
      repository.findTransactionById.mockResolvedValue(transaction({ charge: null }));

      await service.updateTransaction(
        TRANSACTION_ID,
        { reason: 'Разнесена предоплата', chargeId: CHARGE_ID },
        ACCOUNT_ID,
      );

      expect(repository.updateTransaction).toHaveBeenCalledWith(
        TRANSACTION_ID,
        expect.objectContaining({ chargeId: CHARGE_ID }),
        [CHARGE_ID],
      );
    });

    it('пустая строка возвращает платёж в предоплату', async () => {
      await service.updateTransaction(
        TRANSACTION_ID,
        { reason: 'Разнесено по ошибке', chargeId: '' },
        ACCOUNT_ID,
      );

      expect(repository.updateTransaction).toHaveBeenCalledWith(
        TRANSACTION_ID,
        expect.objectContaining({ chargeId: null }),
        [CHARGE_ID],
      );
    });

    it('пересчитывает оба месяца при переносе платежа', async () => {
      repository.findChargeById.mockResolvedValue(charge({ id: OTHER_CHARGE_ID }));

      await service.updateTransaction(
        TRANSACTION_ID,
        { reason: 'Не тот месяц', chargeId: OTHER_CHARGE_ID },
        ACCOUNT_ID,
      );

      expect(repository.updateTransaction).toHaveBeenCalledWith(TRANSACTION_ID, expect.anything(), [
        CHARGE_ID,
        OTHER_CHARGE_ID,
      ]);
    });

    it('сам платёж из остатка месяца исключается', async () => {
      // Месяц закрыт этим же платежом: без исключения самого себя правка
      // суммы 600 → 600 упиралась бы в нулевой остаток.
      repository.findChargeById.mockResolvedValue(
        charge({ paidAmount: '600.00' as unknown as ChargeRow['paidAmount'] }),
      );

      await service.updateTransaction(
        TRANSACTION_ID,
        { reason: 'Уточнение суммы', amount: 900 },
        ACCOUNT_ID,
      );

      expect(repository.updateTransaction).toHaveBeenCalled();
    });

    it('422 на сумму больше остатка месяца', async () => {
      repository.findChargeById.mockResolvedValue(
        charge({ paidAmount: '600.00' as unknown as ChargeRow['paidAmount'] }),
      );

      await expect(
        service.updateTransaction(
          TRANSACTION_ID,
          { reason: 'Слишком много', amount: 1300 },
          ACCOUNT_ID,
        ),
      ).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.updateTransaction).not.toHaveBeenCalled();
    });

    it('422 на месяц другого студента', async () => {
      repository.findTransactionById.mockResolvedValue(
        transaction({
          charge: null,
          student: {
            id: OTHER_STUDENT_ID,
            firstName: 'Дилшод',
            lastName: 'Раҳимов',
            phone: '+992909999999',
          },
        }),
      );

      await expect(
        service.updateTransaction(
          TRANSACTION_ID,
          { reason: 'Разнесение', chargeId: CHARGE_ID },
          ACCOUNT_ID,
        ),
      ).rejects.toThrow(/другого студента/);
    });

    it('422 на несуществующее начисление в теле', async () => {
      repository.findChargeById.mockResolvedValue(null);

      await expect(
        service.updateTransaction(
          TRANSACTION_ID,
          { reason: 'Разнесение', chargeId: OTHER_CHARGE_ID },
          ACCOUNT_ID,
        ),
      ).rejects.toBeInstanceOf(BusinessRuleException);
    });

    it('404 до записи', async () => {
      repository.findTransactionById.mockResolvedValue(null);

      await expect(
        service.updateTransaction(TRANSACTION_ID, { reason: 'Правка' }, ACCOUNT_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.updateTransaction).not.toHaveBeenCalled();
    });
  });

  describe('отмена платежа', () => {
    it('пересчитывает месяц, к которому платёж был привязан', async () => {
      const result = await service.removeTransaction(TRANSACTION_ID, { reason: 'Не тот студент' });

      expect(repository.deleteTransaction).toHaveBeenCalledWith(TRANSACTION_ID, CHARGE_ID);
      expect(result.title).toContain('600 TJS');
    });

    it('отмена предоплаты месяца не трогает', async () => {
      repository.findTransactionById.mockResolvedValue(transaction({ charge: null }));

      await service.removeTransaction(TRANSACTION_ID, { reason: 'Ошибка кассы' });

      expect(repository.deleteTransaction).toHaveBeenCalledWith(TRANSACTION_ID, null);
    });

    it('404 на неизвестный платёж', async () => {
      repository.findTransactionById.mockResolvedValue(null);

      await expect(
        service.removeTransaction(TRANSACTION_ID, { reason: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.deleteTransaction).not.toHaveBeenCalled();
    });
  });
  // ────────────── Закрытый финансовый период (решение 0033) ──────────────────

  describe('закрытый период', () => {
    const AUGUST = new Date('2026-08-01T00:00:00.000Z');
    const archived = {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'III квартал 2026',
      periodFrom: new Date('2026-07-01T00:00:00.000Z'),
      periodTo: SEPTEMBER,
    };

    beforeEach(() => {
      repository.findArchivedPeriodForMonth.mockResolvedValue(archived);
    });

    it('422 на начисление месяца, попавшего в закрытый период', async () => {
      await expect(service.chargeMonth({ month: '2026-09' }, ACCOUNT_ID)).rejects.toBeInstanceOf(
        BusinessRuleException,
      );
      expect(repository.createCharges).not.toHaveBeenCalled();
      expect(repository.findChargeableGroups).not.toHaveBeenCalled();
    });

    it('422 на скидку по месяцу из закрытого периода', async () => {
      await expect(
        service.updateCharge(CHARGE_ID, { discount: 100, discountReason: 'скидка' }),
      ).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.updateCharge).not.toHaveBeenCalled();
    });

    it('422 на удаление начисления из закрытого периода', async () => {
      await expect(service.removeCharge(CHARGE_ID, { reason: 'ошибка' })).rejects.toBeInstanceOf(
        BusinessRuleException,
      );
      expect(repository.deleteCharge).not.toHaveBeenCalled();
    });

    it('422 на платёж, датированный закрытым днём', async () => {
      await expect(
        service.pay({ chargeId: CHARGE_ID, amount: 500, paidAt: '2026-08-15' }, ACCOUNT_ID),
      ).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.createTransaction).not.toHaveBeenCalled();
    });

    it('422 на предоплату, датированную закрытым днём', async () => {
      await expect(
        service.prepay({ studentId: STUDENT_ID, amount: 500, paidAt: '2026-08-15' }, ACCOUNT_ID),
      ).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.createTransaction).not.toHaveBeenCalled();
    });

    it('422 на отмену платежа из закрытого периода', async () => {
      await expect(
        service.removeTransaction(TRANSACTION_ID, { reason: 'ошибка' }),
      ).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.deleteTransaction).not.toHaveBeenCalled();
    });

    it('**платёж открытым днём по месяцу из архива принимается**', async () => {
      // Главное следствие правила: деньги пришли сегодня, и в кассу они
      // попадают сегодняшним днём. Закрыт только август-сентябрь, платёж
      // датирован декабрём, а месяц начисления — сентябрь.
      repository.findArchivedPeriodForMonth.mockImplementation((month: Date) =>
        Promise.resolve(month.getTime() === AUGUST.getTime() ? archived : null),
      );

      await service.pay({ chargeId: CHARGE_ID, amount: 500, paidAt: '2026-12-05' }, ACCOUNT_ID);

      expect(repository.createTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ chargeId: CHARGE_ID }),
      );
      // Проверка идёт по дню платежа, а не по месяцу начисления.
      expect(repository.findArchivedPeriodForMonth).toHaveBeenCalledWith(
        new Date('2026-12-01T00:00:00.000Z'),
      );
    });

    it('перенести платёж **в** закрытый период нельзя', async () => {
      repository.findTransactionById.mockResolvedValue(
        transaction({ paidAt: new Date('2026-12-05T00:00:00.000Z') }),
      );
      repository.findArchivedPeriodForMonth.mockImplementation((month: Date) =>
        Promise.resolve(month.getTime() === AUGUST.getTime() ? archived : null),
      );

      await expect(
        service.updateTransaction(
          TRANSACTION_ID,
          { paidAt: '2026-08-15', reason: 'перенос' },
          ACCOUNT_ID,
        ),
      ).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.updateTransaction).not.toHaveBeenCalled();
    });
  });
});
