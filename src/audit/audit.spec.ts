import { HttpStatus } from '@nestjs/common';

import {
  actionFromPermission,
  actorIdFromResult,
  AuditOutcome,
  entityIdFromParams,
  entityIdFromResult,
  fallbackAction,
  isAuditableMethod,
  isRecordableStatus,
  outcomeOf,
  truncate,
} from './audit';

describe('правила журнала действий (ТЗ 3.6)', () => {
  describe('isAuditableMethod', () => {
    it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s — действие', (method) => {
      expect(isAuditableMethod(method)).toBe(true);
    });

    it.each(['GET', 'HEAD', 'OPTIONS'])('%s — чтение, в журнал не идёт', (method) => {
      expect(isAuditableMethod(method)).toBe(false);
    });

    it('метод в нижнем регистре распознаётся', () => {
      expect(isAuditableMethod('post')).toBe(true);
    });
  });

  describe('outcomeOf', () => {
    it('2xx — действие состоялось', () => {
      expect(outcomeOf(HttpStatus.CREATED)).toBe(AuditOutcome.Success);
      expect(outcomeOf(HttpStatus.ACCEPTED)).toBe(AuditOutcome.Success);
    });

    it('401 и 403 — отказ', () => {
      expect(outcomeOf(HttpStatus.UNAUTHORIZED)).toBe(AuditOutcome.Denied);
      expect(outcomeOf(HttpStatus.FORBIDDEN)).toBe(AuditOutcome.Denied);
    });
  });

  describe('isRecordableStatus', () => {
    it('успешные действия пишутся', () => {
      expect(isRecordableStatus(HttpStatus.OK)).toBe(true);
      expect(isRecordableStatus(HttpStatus.CREATED)).toBe(true);
      expect(isRecordableStatus(HttpStatus.ACCEPTED)).toBe(true);
    });

    it('отказы доступа пишутся', () => {
      expect(isRecordableStatus(HttpStatus.UNAUTHORIZED)).toBe(true);
      expect(isRecordableStatus(HttpStatus.FORBIDDEN)).toBe(true);
    });

    it('ошибки формы и бизнес-правил не пишутся — это не действия', () => {
      expect(isRecordableStatus(HttpStatus.BAD_REQUEST)).toBe(false);
      expect(isRecordableStatus(HttpStatus.UNPROCESSABLE_ENTITY)).toBe(false);
      expect(isRecordableStatus(HttpStatus.CONFLICT)).toBe(false);
      expect(isRecordableStatus(HttpStatus.NOT_FOUND)).toBe(false);
    });

    it('ошибка сервера не пишется — она уходит в лог со стектрейсом', () => {
      expect(isRecordableStatus(HttpStatus.INTERNAL_SERVER_ERROR)).toBe(false);
    });
  });

  describe('actionFromPermission', () => {
    it('снимает префикс каталога', () => {
      expect(actionFromPermission('Permission.Students.Create')).toBe('Students.Create');
      expect(actionFromPermission('Permission.Accounting.ManageSalary')).toBe(
        'Accounting.ManageSalary',
      );
    });

    it('строку без префикса оставляет как есть', () => {
      expect(actionFromPermission('Auth.Login')).toBe('Auth.Login');
    });
  });

  describe('fallbackAction', () => {
    it('имя класса без суффикса Controller плюс обработчик', () => {
      expect(fallbackAction('MentorCabinetController', 'createAvansRequest')).toBe(
        'MentorCabinet.createAvansRequest',
      );
    });

    it('класс без суффикса не портится', () => {
      expect(fallbackAction('Mentor', 'create')).toBe('Mentor.create');
    });
  });

  describe('entityIdFromParams', () => {
    it('берёт `id` из пути', () => {
      expect(entityIdFromParams({ id: 'a1' })).toBe('a1');
    });

    it('пути без `id` объекта действия не называют', () => {
      expect(entityIdFromParams({})).toBeNull();
      expect(entityIdFromParams(undefined)).toBeNull();
      expect(entityIdFromParams({ studentId: 'a1' })).toBeNull();
    });

    it('не-строковый и слишком длинный идентификатор отбрасываются', () => {
      expect(entityIdFromParams({ id: 42 })).toBeNull();
      expect(entityIdFromParams({ id: 'x'.repeat(65) })).toBeNull();
      expect(entityIdFromParams({ id: '' })).toBeNull();
    });

    it('месяц ключом тоже годится (`DELETE /leaders/winners/2026-07`)', () => {
      expect(entityIdFromParams({ id: '2026-07' })).toBe('2026-07');
    });
  });

  describe('entityIdFromResult', () => {
    it('у создания идентификатор берётся из ответа', () => {
      expect(entityIdFromResult({ id: 'b2', name: 'Группа' })).toBe('b2');
    });

    it('разворачивает обёртку `{ data }`, кто бы из перехватчиков ни был снаружи', () => {
      expect(entityIdFromResult({ data: { id: 'b2' } })).toBe('b2');
    });

    it('ответ без идентификатора — null', () => {
      expect(entityIdFromResult({ count: 3 })).toBeNull();
      expect(entityIdFromResult(null)).toBeNull();
      expect(entityIdFromResult('строка')).toBeNull();
    });
  });

  describe('actorIdFromResult', () => {
    it('вход и регистрация называют аккаунт в ответе', () => {
      expect(actorIdFromResult({ account: { id: 'acc-1' }, tokens: {} })).toBe('acc-1');
    });

    it('работает и через обёртку `{ data }`', () => {
      expect(actorIdFromResult({ data: { account: { id: 'acc-1' } } })).toBe('acc-1');
    });

    it('ответ без аккаунта действующего лица не называет', () => {
      expect(actorIdFromResult({ id: 'student-1' })).toBeNull();
      expect(actorIdFromResult(null)).toBeNull();
      expect(actorIdFromResult('строка')).toBeNull();
    });
  });

  describe('truncate', () => {
    it('обрезает длинное и пропускает короткое', () => {
      expect(truncate('a'.repeat(300))).toHaveLength(255);
      expect(truncate('Mozilla/5.0')).toBe('Mozilla/5.0');
    });

    it('пустое значение — null, а не пустая строка', () => {
      expect(truncate('')).toBeNull();
      expect(truncate(undefined)).toBeNull();
      expect(truncate(null)).toBeNull();
    });
  });
});
