import { Gender } from '@prisma/client';

import type { ExistingStudentProfile, LeadForTransfer } from './leads-transfer';
import {
  LEAD_TRANSFER_ALREADY_DONE,
  LEAD_TRANSFER_DUPLICATE_PHONE,
  LEAD_TRANSFER_NOT_FOUND,
  LEAD_TRANSFER_PROFILE_TAKEN,
  planLeadTransfers,
  studentProfileOf,
} from './leads-transfer';

const L1 = '11111111-1111-1111-1111-111111111111';
const L2 = '22222222-2222-2222-2222-222222222222';
const L3 = '33333333-3333-3333-3333-333333333333';
const S1 = 'aaaaaaaa-1111-1111-1111-111111111111';
const BRANCH_ID = 'bbbbbbbb-1111-1111-1111-111111111111';

const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

const lead = (overrides: Partial<LeadForTransfer> = {}): LeadForTransfer => ({
  id: L1,
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

const student = (overrides: Partial<ExistingStudentProfile> = {}): ExistingStudentProfile => ({
  id: S1,
  phone: '+992901234567',
  lastName: 'Каримова',
  firstName: 'Нигина',
  leadOriginId: null,
  ...overrides,
});

describe('studentProfileOf (ТЗ 5.7 → ТЗ 5.3)', () => {
  it('переносит в профиль поля человека: ФИО, телефон, ДР, пол, почту и филиал', () => {
    expect(
      studentProfileOf(
        lead({
          email: 'nigina@mail.tj',
          birthDate: day('2004-05-17'),
          gender: Gender.FEMALE,
          branchId: BRANCH_ID,
        }),
      ),
    ).toEqual({
      firstName: 'Нигина',
      lastName: 'Каримова',
      phone: '+992901234567',
      email: 'nigina@mail.tj',
      birthDate: day('2004-05-17'),
      gender: Gender.FEMALE,
      branchId: BRANCH_ID,
    });
  });

  it('незаполненные поля обращения остаются пустыми в профиле, а не пропадают', () => {
    expect(studentProfileOf(lead())).toEqual({
      firstName: 'Нигина',
      lastName: 'Каримова',
      phone: '+992901234567',
      email: null,
      birthDate: null,
      gender: null,
      branchId: null,
    });
  });

  it('поля обращения (заметки, UTM, курс) в профиль не переносятся', () => {
    // Они описывают звонок, а не человека: копия в карточке разошлась бы
    // с оригиналом при первой же правке.
    expect(Object.keys(studentProfileOf(lead())).sort()).toEqual([
      'birthDate',
      'branchId',
      'email',
      'firstName',
      'gender',
      'lastName',
      'phone',
    ]);
  });
});

describe('planLeadTransfers (ТЗ 5.7: «Transfer в студенты»)', () => {
  it('обращение без совпадающего профиля заводит новый', () => {
    expect(planLeadTransfers([L1], [lead()], [])).toEqual({
      planned: [{ leadId: L1, action: 'created', studentId: null }],
      rejected: [],
    });
  });

  it('телефон, занятый свободным профилем, привязывает к нему, а не отказывает', () => {
    // Главное решение куска: обращение всё-таки стало студентом, и отказ
    // вычеркнул бы из воронки ровно тот случай, ради которого её ведут.
    expect(planLeadTransfers([L1], [lead()], [student()])).toEqual({
      planned: [{ leadId: L1, action: 'linked', studentId: S1 }],
      rejected: [],
    });
  });

  it('профиль с другим телефоном на решение не влияет', () => {
    expect(
      planLeadTransfers([L1], [lead()], [student({ phone: '+992905550000' })]).planned,
    ).toEqual([{ leadId: L1, action: 'created', studentId: null }]);
  });

  it('ненайденное обращение попадает в отказ, а не пропадает молча', () => {
    expect(planLeadTransfers([L1, L2], [lead()], [])).toEqual({
      planned: [{ leadId: L1, action: 'created', studentId: null }],
      rejected: [{ leadId: L2, reason: LEAD_TRANSFER_NOT_FOUND }],
    });
  });

  it('уже переведённое обращение второй раз не переводится', () => {
    expect(planLeadTransfers([L1], [lead({ convertedStudentId: S1 })], []).rejected).toEqual([
      { leadId: L1, reason: LEAD_TRANSFER_ALREADY_DONE },
    ]);
  });

  it('профиль, заведённый из другого обращения, привязать нельзя', () => {
    // `Lead.convertedStudentId` уникален — иначе это была бы ошибка индекса
    // вместо внятной причины.
    expect(planLeadTransfers([L1], [lead()], [student({ leadOriginId: L3 })]).rejected).toEqual([
      { leadId: L1, reason: LEAD_TRANSFER_PROFILE_TAKEN },
    ]);
  });

  it('профиль, заведённый из этого же обращения, всё равно не привязывается второй раз', () => {
    // Такое состояние означало бы, что перевод уже был; ловится более ранней
    // проверкой «уже переведено», и именно она называется в отчёте.
    expect(
      planLeadTransfers([L1], [lead({ convertedStudentId: S1 })], [student({ leadOriginId: L1 })])
        .rejected,
    ).toEqual([{ leadId: L1, reason: LEAD_TRANSFER_ALREADY_DONE }]);
  });

  it('два обращения с одним телефоном: телефон занимает первое, второе отвергается', () => {
    const plan = planLeadTransfers(
      [L1, L2],
      [lead({ id: L1 }), lead({ id: L2, firstName: 'Нигинa' })],
      [],
    );

    expect(plan.planned).toEqual([{ leadId: L1, action: 'created', studentId: null }]);
    expect(plan.rejected).toEqual([{ leadId: L2, reason: LEAD_TRANSFER_DUPLICATE_PHONE }]);
  });

  it('повтор телефона в пачке отвергается и при привязке к существующему профилю', () => {
    // Оба указали бы на один профиль, а ссылка на него уникальна.
    const plan = planLeadTransfers([L1, L2], [lead({ id: L1 }), lead({ id: L2 })], [student()]);

    expect(plan.planned).toEqual([{ leadId: L1, action: 'linked', studentId: S1 }]);
    expect(plan.rejected).toEqual([{ leadId: L2, reason: LEAD_TRANSFER_DUPLICATE_PHONE }]);
  });

  it('разные телефоны в одной пачке друг другу не мешают', () => {
    expect(
      planLeadTransfers([L1, L2], [lead({ id: L1 }), lead({ id: L2, phone: '+992905550000' })], [])
        .rejected,
    ).toEqual([]);
  });

  it('порядок ответа повторяет порядок запроса', () => {
    const plan = planLeadTransfers(
      [L3, L1, L2],
      [
        lead({ id: L1, phone: '+992901111111' }),
        lead({ id: L2, phone: '+992902222222' }),
        lead({ id: L3, phone: '+992903333333' }),
      ],
      [],
    );

    expect(plan.planned.map(({ leadId }) => leadId)).toEqual([L3, L1, L2]);
  });

  it('собирает все причины сразу, а не останавливается на первой', () => {
    const plan = planLeadTransfers(
      [L1, L2, L3],
      [lead({ id: L1, convertedStudentId: S1 }), lead({ id: L2, phone: '+992905550000' })],
      [student({ phone: '+992905550000', leadOriginId: 'other' })],
    );

    expect(plan.planned).toEqual([]);
    expect(plan.rejected).toEqual([
      { leadId: L1, reason: LEAD_TRANSFER_ALREADY_DONE },
      { leadId: L2, reason: LEAD_TRANSFER_PROFILE_TAKEN },
      { leadId: L3, reason: LEAD_TRANSFER_NOT_FOUND },
    ]);
  });

  it('пустая пачка ничего не планирует и ни на что не жалуется', () => {
    expect(planLeadTransfers([], [], [])).toEqual({ planned: [], rejected: [] });
  });

  it('вход не изменяется', () => {
    const leads = [lead()];
    const students = [student()];
    const ids = [L1];

    planLeadTransfers(ids, leads, students);

    expect(ids).toEqual([L1]);
    expect(leads[0].convertedStudentId).toBeNull();
    expect(students[0].leadOriginId).toBeNull();
  });
});
