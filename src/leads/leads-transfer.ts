import type { Gender } from '@prisma/client';

/**
 * Перевод лида в студенты (ТЗ 5.7: «Transfer в студенты (bulk/по строке)»).
 *
 * Правило вынесено в чистые функции, потому что оно решает три вопроса сразу,
 * и каждый из них неочевиден: заводить профиль или привязаться к существующему,
 * какие поля обращения вообще являются полями человека и что делать с пачкой,
 * внутри которой два обращения указывают на один и тот же номер.
 */

/** Что нужно знать об обращении, чтобы решить и выполнить перевод. */
export interface LeadForTransfer {
  id: string;
  firstName: string;
  lastName: string;
  /** E.164 — по нему ищется существующий профиль (`Student.phone` уникален). */
  phone: string;
  email: string | null;
  birthDate: Date | null;
  gender: Gender | null;
  branchId: string | null;
  /** Заполнено — обращение уже переведено, повторный перевод не делается. */
  convertedStudentId: string | null;
}

/** Профиль студента с тем же телефоном, если он уже заведён. */
export interface ExistingStudentProfile {
  id: string;
  phone: string;
  lastName: string;
  firstName: string;
  /**
   * Обращение, из которого этот профиль уже заведён. `Lead.convertedStudentId`
   * уникален, поэтому занятый профиль привязать второй раз нельзя — и упереться
   * в это должен внятный отказ, а не ошибка уникального индекса.
   */
  leadOriginId: string | null;
}

/** Что случилось с обращением: завели профиль или привязали существующий. */
export type LeadTransferAction = 'created' | 'linked';

export interface PlannedLeadTransfer {
  leadId: string;
  action: LeadTransferAction;
  /** Профиль, к которому привязывается обращение; `null` — его ещё нужно завести. */
  studentId: string | null;
}

export interface RejectedLeadTransfer {
  leadId: string;
  reason: string;
}

export interface LeadTransferPlan {
  planned: PlannedLeadTransfer[];
  rejected: RejectedLeadTransfer[];
}

/**
 * Причины отказа — константами, а не строками по месту: их сверяют и тесты,
 * и оператор в отчёте, а разъехавшиеся формулировки означали бы, что отчёт
 * говорит одно, а проверка ловит другое.
 */
export const LEAD_TRANSFER_NOT_FOUND = 'обращение не найдено';
export const LEAD_TRANSFER_ALREADY_DONE = 'обращение уже переведено в студенты';
export const LEAD_TRANSFER_PROFILE_TAKEN =
  'профиль студента с этим телефоном заведён из другого обращения';
export const LEAD_TRANSFER_DUPLICATE_PHONE =
  'в этой же пачке есть другое обращение с тем же телефоном';

/**
 * Поля профиля студента, взятые у обращения (ТЗ 5.3 — форма карточки, ТЗ 5.7 —
 * форма лида).
 *
 * Переносится только то, что описывает **человека**: ФИО, телефон, дата
 * рождения, пол, почта и филиал. `occupation`, `notes`, UTM, источник, купон,
 * месяц записи и время урока остаются у обращения — они описывают **звонок**,
 * а не студента, и копия в карточке разошлась бы с оригиналом при первой же
 * правке (то же соображение, по которому в проекте не заводятся вторые
 * источники истины — 0012, 0019, 0025, 0026).
 *
 * Курс не переносится тоже, и это не пропуск: интересующий курс — не членство
 * в группе. Зачисление остаётся отдельным действием состава (0012) со своими
 * правилами «одно действующее членство на курс».
 */
export interface LeadStudentProfile {
  firstName: string;
  lastName: string;
  phone: string;
  birthDate: Date | null;
  gender: Gender | null;
  email: string | null;
  branchId: string | null;
}

export const studentProfileOf = (lead: LeadForTransfer): LeadStudentProfile => ({
  firstName: lead.firstName,
  lastName: lead.lastName,
  phone: lead.phone,
  birthDate: lead.birthDate,
  gender: lead.gender,
  email: lead.email,
  branchId: lead.branchId,
});

/**
 * Раскладывает запрошенную пачку на «что сделать» и «почему нельзя».
 *
 * Порядок проверок задан тем, какой ответ полезнее оператору: сначала
 * ненайденные обращения, потом уже переведённые, потом столкновения телефонов.
 *
 * Телефон, занятый **свободным** профилем, отказом не является — это главное
 * решение куска: обращение всё-таки стало студентом, и отказ вычеркнул бы
 * из воронки ровно тот случай, ради измерения которого её ведут (ТЗ 5.2).
 * Профиль при этом не создаётся второй раз — `Student.phone` уникален
 * с Фазы 1, а действие называется в ответе (`created`/`linked`), чтобы
 * «перевели 5» и «завели 5 карточек» не путались между собой.
 *
 * Внутри одной пачки телефон занимается **первым** обращением: два лида
 * с одним номером указывали бы на один профиль, а `Lead.convertedStudentId`
 * уникален. Молча перевести только первого нельзя — оператор счёл бы
 * переведёнными обоих.
 */
export const planLeadTransfers = (
  requestedIds: readonly string[],
  leads: readonly LeadForTransfer[],
  students: readonly ExistingStudentProfile[],
): LeadTransferPlan => {
  const byId = new Map(leads.map((lead) => [lead.id, lead]));
  const byPhone = new Map(students.map((student) => [student.phone, student]));

  const planned: PlannedLeadTransfer[] = [];
  const rejected: RejectedLeadTransfer[] = [];
  /** Номера, уже занятые обращениями этой же пачки. */
  const claimedPhones = new Set<string>();

  for (const leadId of requestedIds) {
    const lead = byId.get(leadId);

    if (lead === undefined) {
      rejected.push({ leadId, reason: LEAD_TRANSFER_NOT_FOUND });
      continue;
    }

    if (lead.convertedStudentId !== null) {
      rejected.push({ leadId, reason: LEAD_TRANSFER_ALREADY_DONE });
      continue;
    }

    if (claimedPhones.has(lead.phone)) {
      rejected.push({ leadId, reason: LEAD_TRANSFER_DUPLICATE_PHONE });
      continue;
    }

    const existing = byPhone.get(lead.phone);

    if (existing !== undefined && existing.leadOriginId !== null) {
      rejected.push({ leadId, reason: LEAD_TRANSFER_PROFILE_TAKEN });
      continue;
    }

    claimedPhones.add(lead.phone);
    planned.push(
      existing === undefined
        ? { leadId, action: 'created', studentId: null }
        : { leadId, action: 'linked', studentId: existing.id },
    );
  }

  return { planned, rejected };
};
