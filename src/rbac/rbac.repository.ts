import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import type { PermissionDefinition } from './permission-catalog';

/** Строка каталога прав в том объёме, в каком её сверяет синхронизация. */
export interface StoredPermission {
  id: string;
  code: string;
  section: string;
  action: string;
  description: string | null;
  isSystem: boolean;
}

/**
 * Доступ к данным RBAC (`Controller → Service → Repository`).
 * Бизнес-правил здесь нет — только запросы Prisma.
 */
@Injectable()
export class RbacRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Права аккаунта = объединение прав всех позиций его сотрудника (ТЗ 3.2).
   *
   * Одним запросом от таблицы прав: строки в `permission` не дублируются,
   * поэтому union получается сам собой, без сборки в приложении.
   * Выключенные в каталоге права не выдаются никому (toggle, ТЗ 5.15).
   */
  findAccountPermissionCodes(accountId: string): Promise<{ code: string }[]> {
    return this.prisma.permission.findMany({
      where: {
        isEnabled: true,
        positions: { some: { position: { employees: { some: { employee: { accountId } } } } } },
      },
      select: { code: true },
      orderBy: { code: 'asc' },
    });
  }

  /** Весь каталог из БД — для сверки с каталогом в коде при старте. */
  findAllPermissions(): Promise<StoredPermission[]> {
    return this.prisma.permission.findMany({
      select: {
        id: true,
        code: true,
        section: true,
        action: true,
        description: true,
        isSystem: true,
      },
    });
  }

  async createPermissions(definitions: readonly PermissionDefinition[]): Promise<number> {
    const { count } = await this.prisma.permission.createMany({
      data: definitions.map(({ code, section, action, description, isSystem }) => ({
        code,
        section,
        action,
        description,
        isSystem,
      })),
      // Гонка двух экземпляров приложения на старте: код уникален, второй просто пропустит.
      skipDuplicates: true,
    });

    return count;
  }

  /** Приводит описание права к каталогу. `isEnabled` не трогается — им управляет администратор. */
  async updatePermission(id: string, definition: PermissionDefinition): Promise<void> {
    await this.prisma.permission.update({
      where: { id },
      data: {
        section: definition.section,
        action: definition.action,
        description: definition.description,
        isSystem: definition.isSystem,
      },
    });
  }

  /**
   * Системная позиция всегда существует и держит **все** права каталога.
   * Иначе после каждой фазы, добавляющей права, у Director'а не хватало бы доступа
   * к новому разделу, а починить это было бы некому: назначение прав само под правом.
   *
   * @returns сколько прав добавлено к позиции этим вызовом.
   */
  async syncSystemPosition(name: string, description: string): Promise<number> {
    const position = await this.prisma.position.upsert({
      where: { name },
      create: { name, description, isSystem: true },
      update: { isSystem: true },
      select: { id: true },
    });

    const missing = await this.prisma.permission.findMany({
      where: { positions: { none: { positionId: position.id } } },
      select: { id: true },
    });

    if (missing.length === 0) return 0;

    const { count } = await this.prisma.positionPermission.createMany({
      data: missing.map(({ id }) => ({ positionId: position.id, permissionId: id })),
      skipDuplicates: true,
    });

    return count;
  }
}
