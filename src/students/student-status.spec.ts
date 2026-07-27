import { GroupStudentStatus, StudentStatus } from '@prisma/client';

import type { MembershipStatusSnapshot } from './student-status';
import { deriveStudentStatus } from './student-status';

const at = (iso: string): Date => new Date(iso);

const membership = (
  status: GroupStudentStatus,
  statusChangedAt: Date | null = null,
): MembershipStatusSnapshot => ({ status, statusChangedAt });

describe('deriveStudentStatus', () => {
  describe('Есть действующее членство', () => {
    it('учащийся студент — ACTIVE', () => {
      expect(
        deriveStudentStatus(StudentStatus.NO_ACTIVE, [membership(GroupStudentStatus.ACTIVE)]),
      ).toBe(StudentStatus.ACTIVE);
    });

    it('одно действующее членство перевешивает закрытые', () => {
      expect(
        deriveStudentStatus(StudentStatus.FINISHED, [
          membership(GroupStudentStatus.LEFT, at('2026-05-01T00:00:00.000Z')),
          membership(GroupStudentStatus.ACTIVE),
        ]),
      ).toBe(StudentStatus.ACTIVE);
    });

    it('вернувшийся выпускник снова ACTIVE', () => {
      expect(
        deriveStudentStatus(StudentStatus.FINISHED, [
          membership(GroupStudentStatus.FINISHED, at('2026-03-01T00:00:00.000Z')),
          membership(GroupStudentStatus.ACTIVE),
        ]),
      ).toBe(StudentStatus.ACTIVE);
    });
  });

  describe('Действующих членств не осталось', () => {
    it('ушёл с курса — NO_ACTIVE (ТЗ 5.12: попадает в Left courses)', () => {
      expect(
        deriveStudentStatus(StudentStatus.ACTIVE, [
          membership(GroupStudentStatus.LEFT, at('2026-05-01T00:00:00.000Z')),
        ]),
      ).toBe(StudentStatus.NO_ACTIVE);
    });

    it('прошёл курс — FINISHED', () => {
      expect(
        deriveStudentStatus(StudentStatus.ACTIVE, [
          membership(GroupStudentStatus.FINISHED, at('2026-05-01T00:00:00.000Z')),
        ]),
      ).toBe(StudentStatus.FINISHED);
    });

    it('переведённое в никуда членство считается уходом', () => {
      // Строка `TRANSFERRED` без действующей пары остаётся, если членство
      // в группе назначения потом убрали из состава.
      expect(
        deriveStudentStatus(StudentStatus.ACTIVE, [
          membership(GroupStudentStatus.TRANSFERRED, at('2026-05-01T00:00:00.000Z')),
        ]),
      ).toBe(StudentStatus.NO_ACTIVE);
    });

    it('выпускник, бросивший второй курс, — NO_ACTIVE: считается последнее событие', () => {
      expect(
        deriveStudentStatus(StudentStatus.FINISHED, [
          membership(GroupStudentStatus.FINISHED, at('2026-03-01T00:00:00.000Z')),
          membership(GroupStudentStatus.LEFT, at('2026-06-01T00:00:00.000Z')),
        ]),
      ).toBe(StudentStatus.NO_ACTIVE);
    });

    it('бросивший когда-то курс, но доучившийся на втором, — FINISHED', () => {
      expect(
        deriveStudentStatus(StudentStatus.NO_ACTIVE, [
          membership(GroupStudentStatus.LEFT, at('2026-03-01T00:00:00.000Z')),
          membership(GroupStudentStatus.FINISHED, at('2026-06-01T00:00:00.000Z')),
        ]),
      ).toBe(StudentStatus.FINISHED);
    });

    it('порядок членств в списке на вывод не влияет', () => {
      const history = [
        membership(GroupStudentStatus.FINISHED, at('2026-06-01T00:00:00.000Z')),
        membership(GroupStudentStatus.LEFT, at('2026-03-01T00:00:00.000Z')),
      ];

      expect(deriveStudentStatus(StudentStatus.ACTIVE, history)).toBe(StudentStatus.FINISHED);
      expect(deriveStudentStatus(StudentStatus.ACTIVE, [...history].reverse())).toBe(
        StudentStatus.FINISHED,
      );
    });

    it('членство без даты считается самым давним, но не выпадает из вывода', () => {
      expect(
        deriveStudentStatus(StudentStatus.ACTIVE, [membership(GroupStudentStatus.LEFT, null)]),
      ).toBe(StudentStatus.NO_ACTIVE);
    });
  });

  describe('Когда статус не трогается', () => {
    it('BLOCK автоматика не перебивает — это запрет входа, а не факт учёбы', () => {
      expect(
        deriveStudentStatus(StudentStatus.BLOCK, [membership(GroupStudentStatus.ACTIVE)]),
      ).toBeNull();
    });

    it('заблокированный не разблокируется уходом из группы', () => {
      expect(
        deriveStudentStatus(StudentStatus.BLOCK, [
          membership(GroupStudentStatus.LEFT, at('2026-05-01T00:00:00.000Z')),
        ]),
      ).toBeNull();
    });

    it('профиль без единого членства ведёт оператор', () => {
      expect(deriveStudentStatus(StudentStatus.FINISHED, [])).toBeNull();
    });

    it('совпадающий статус не переписывается', () => {
      expect(
        deriveStudentStatus(StudentStatus.ACTIVE, [membership(GroupStudentStatus.ACTIVE)]),
      ).toBeNull();
    });
  });
});
