import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AccountType } from '@prisma/client';

import { BusinessRuleException, parseIsoDate } from '../common';
import { PhoneService } from '../phone';
import type { PromoteStudentDto, PromoteStudentResponseDto } from './dto';
import type { PromoteStudentResult, StudentForPromotion } from './students.repository';
import { StudentsRepository } from './students.repository';

/**
 * Перевод Студент → Сотрудник (ТЗ 3.1: «выпускник → ментор»).
 *
 * Три требования ТЗ, вокруг которых построен сценарий:
 *   1. **Логин не меняется** — аккаунт не пересоздаётся, `phone`/`email`/хеш пароля
 *      остаются прежними, меняется только `type`.
 *   2. **Учебная история сохраняется** — строка `Student` не удаляется и не копируется;
 *      журнал, баллы и коины (Фаза 5) продолжают ссылаться на тот же профиль.
 *   3. **Профиль один** — аккаунт отвязывается от студента и привязывается к сотруднику,
 *      связь с прошлым остаётся в `Employee.formerStudentId`.
 *
 * Статус студента намеренно не трогается: человек может дальше учиться на другом
 * курсе, оставаясь ментором, и переводить его в `Finished` за это нельзя.
 */
@Injectable()
export class StudentPromotionService {
  private readonly logger = new Logger(StudentPromotionService.name);

  constructor(
    private readonly repository: StudentsRepository,
    private readonly phones: PhoneService,
  ) {}

  async promoteToEmployee(
    studentId: string,
    dto: PromoteStudentDto,
  ): Promise<PromoteStudentResponseDto> {
    const student = await this.repository.findForPromotion(studentId);
    if (!student) {
      throw new NotFoundException('Студент не найден');
    }

    if (student.promotedEmployee) {
      throw new ConflictException('Студент уже переведён в сотрудники');
    }

    // Профиль студента мог быть заведён без аккаунта (ТЗ 5.3) — тогда переводим
    // только профиль, а логин заведут позже приглашением.
    if (student.account && student.account.type !== AccountType.STUDENT) {
      throw new BusinessRuleException('Аккаунт уже принадлежит сотруднику');
    }

    const phone = this.phones.normalizeOptional(dto.phone, 'phone') ?? student.phone;

    const employeeWithSamePhone = await this.repository.findEmployeeByPhone(phone);
    if (employeeWithSamePhone) {
      throw new ConflictException('Сотрудник с таким номером телефона уже существует');
    }

    const result = await this.repository.promoteToEmployee({
      studentId: student.id,
      accountId: student.accountId,
      employee: {
        firstName: student.firstName,
        lastName: student.lastName,
        middleName: dto.middleName,
        birthDate: student.birthDate,
        gender: student.gender,
        address: student.address,
        email: student.email,
        phone,
        telegram: student.telegram,
        photoUrl: student.photoUrl,
        branchId: student.branchId,
        experience: dto.experience,
        description: dto.description,
        hiredAt: hireDate(dto.hiredAt),
      },
    });

    this.logger.log(
      `Студент ${student.id} переведён в сотрудники ${result.employee.id}` +
        (student.accountId === null
          ? ' (без аккаунта)'
          : `; аккаунт ${student.accountId}, погашено сессий: ${String(result.revokedSessions)}`),
    );

    return toResponse(result, student);
  }
}

/** Дата приёма: из тела запроса либо сегодняшний день (колонка хранит дату без времени). */
function hireDate(value: string | undefined): Date {
  if (value !== undefined) {
    return parseIsoDate(value, 'hiredAt', 'Некорректная дата приёма на работу');
  }

  return new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
}

function toResponse(
  result: PromoteStudentResult,
  student: StudentForPromotion,
): PromoteStudentResponseDto {
  const { employee, account, revokedSessions } = result;

  return {
    employee: {
      id: employee.id,
      firstName: employee.firstName,
      lastName: employee.lastName,
      middleName: employee.middleName,
      phone: employee.phone,
      email: employee.email,
      status: employee.status,
      hiredAt: employee.hiredAt?.toISOString().slice(0, 10) ?? null,
      // Связь с учебной историей: репозиторий её проставил, но подстраховываемся
      // идентификатором студента, ради которого перевод и делался.
      formerStudentId: employee.formerStudentId ?? student.id,
    },
    account,
    revokedSessions,
  };
}
