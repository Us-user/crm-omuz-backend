import { Injectable, Logger } from '@nestjs/common';

import { AuditRepository } from './audit.repository';

/** Действие в том виде, в каком его собрал перехватчик: без снимка о человеке. */
export interface AuditEntry {
  accountId: string | null;
  action: string;
  method: string;
  path: string;
  entityId: string | null;
  statusCode: number;
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
}

/**
 * Запись действия в журнал (ТЗ 3.6).
 *
 * Два свойства, ради которых это отдельный сервис, а не тело перехватчика:
 *
 * 1. **Никогда не бросает.** Журнал описывает операцию, а не выполняет её:
 *    сбой записи не имеет права отменить уже состоявшееся действие. Потерянная
 *    строка уходит предупреждением в лог приложения — единственное место,
 *    где о ней ещё можно узнать.
 * 2. **Снимок о человеке берётся здесь**, потому что запись идёт уже после
 *    ответа клиенту: лишний запрос к аккаунту не удлиняет сам запрос.
 */
@Injectable()
export class AuditRecorder {
  private readonly logger = new Logger(AuditRecorder.name);

  constructor(private readonly repository: AuditRepository) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      const actor =
        entry.accountId === null ? null : await this.repository.findActor(entry.accountId);

      await this.repository.create({
        // Аккаунта уже нет — значит, действие удалило его самого (сотрудник
        // убрал собственный профиль). Ссылку ставить нельзя: внешний ключ
        // отверг бы строку, и действие пропало бы из журнала целиком.
        accountId: actor === null ? null : entry.accountId,
        actorName: actor === null ? null : nameOf(actor.firstName, actor.lastName),
        actorPhone: actor?.phone ?? null,
        actorType: actor?.type ?? null,
        action: entry.action,
        method: entry.method,
        path: entry.path,
        entityId: entry.entityId,
        statusCode: entry.statusCode,
        requestId: entry.requestId,
        ip: entry.ip,
        userAgent: entry.userAgent,
      });
    } catch (error) {
      this.logger.warn(
        `Действие ${entry.action} не записано в журнал: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/** Имя и фамилия одной строкой; аккаунт без профиля остаётся без имени. */
const nameOf = (firstName: string | null, lastName: string | null): string | null => {
  const name = [firstName, lastName].filter((part) => part !== null && part !== '').join(' ');

  return name === '' ? null : name;
};
