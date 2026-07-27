import { randomBytes } from 'node:crypto';

import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AccountStatus, AccountType, Locale, StudentStatus } from '@prisma/client';

import { PASSWORD_RESET_TTL_SECONDS, PasswordService } from '../auth';
import { PasswordResetService } from '../auth/password-reset.service';
import { BusinessRuleException } from '../common';
import { MailerService } from '../mailer';
import { statusAfterUnblock } from '../students/student-status';
import type {
  BlockStudentDto,
  InviteStudentDto,
  StudentBlockedDto,
  StudentInvitedDto,
} from './dto';
import type { StudentAccessRow } from './student-access.repository';
import { StudentAccessRepository } from './student-access.repository';
import { renderStudentInviteEmail } from './student-invite.templates';

/**
 * Длина случайного секрета, которым закрывается свежий аккаунт приглашённого.
 * Хеш от него ложится в `passwordHash`, чтобы колонка не была пустой, а войти
 * по нему нельзя ни студенту, ни тому, кто его пригласил: значения не знает никто.
 */
const UNUSABLE_SECRET_BYTES = 48;

/**
 * Доступ студента в систему (ТЗ 5.3): «Invite» — выдача логина заведённому
 * профилю, «Block» — обратимое закрытие входа.
 *
 * Оба действия трогают и профиль, и аккаунт, поэтому живут вместе и отдельно
 * от карточки: карточка (`StudentsService`) правит поля формы, а здесь
 * решается, может ли человек войти.
 *
 * Правила модуля:
 *   - блокировка ставит `Student.status = BLOCK` **и** `Account.status = BLOCKED`
 *     одной транзакцией, разблокировка возвращает статус, выведенный из членств;
 *   - приглашение не придумывает пароль: аккаунт заводится с непригодным
 *     секретом, а студент задаёт свой пароль по одноразовому коду из письма —
 *     тем же путём `POST /auth/password/reset`, что и при забытом пароле;
 *   - приглашённый уже студент повторно не приглашается (409): логин у него есть,
 *     а забытый пароль восстанавливается публичным `POST /auth/password/forgot`.
 */
@Injectable()
export class StudentAccessService {
  private readonly logger = new Logger(StudentAccessService.name);

  constructor(
    private readonly repository: StudentAccessRepository,
    private readonly passwords: PasswordService,
    private readonly passwordReset: PasswordResetService,
    private readonly mailer: MailerService,
  ) {}

  /** Блокировка и разблокировка входа (`POST /students/{id}/block`). */
  async block(
    studentId: string,
    dto: BlockStudentDto,
    actorAccountId: string,
  ): Promise<StudentBlockedDto> {
    const student = await this.require(studentId);

    // Блокировка — единственный способ поставить `BLOCK` (ТЗ 5.3): правка карточки
    // этот статус не принимает, иначе вход и статус разошлись бы.
    const status = dto.blocked ? StudentStatus.BLOCK : this.statusForUnblock(student);
    const accountStatus = dto.blocked ? AccountStatus.BLOCKED : AccountStatus.ACTIVE;

    const { account, revokedSessions } = await this.repository.setBlocked({
      studentId,
      // Совпадающее значение до БД не доходит — как и в остальных модулях проекта.
      studentStatus: status === student.status ? undefined : status,
      accountId: student.accountId,
      accountStatus: student.account?.status === accountStatus ? undefined : accountStatus,
      // Гасить сессии имеет смысл только при закрытии входа: обновить токены
      // заблокированный больше не сможет. Выданный ранее access-токен доживёт
      // свой час — стратегия намеренно не ходит в БД (решение сессии 0002).
      revokeSessions: dto.blocked && student.accountId !== null,
    });

    const fullName = nameOf(student);
    this.logger.log(
      `${dto.blocked ? 'Заблокирован' : 'Разблокирован'} студент ${fullName} (${studentId}); ` +
        `выполнил аккаунт ${actorAccountId}` +
        (revokedSessions > 0 ? `, погашено сессий: ${String(revokedSessions)}` : ''),
    );

    return { id: studentId, fullName, blocked: dto.blocked, status, account, revokedSessions };
  }

  /** Выдача логина заведённому профилю (`POST /students/{id}/invite`). */
  async invite(
    studentId: string,
    dto: InviteStudentDto,
    actorAccountId: string,
  ): Promise<StudentInvitedDto> {
    const student = await this.require(studentId);

    if (student.accountId !== null) {
      throw new ConflictException(
        'У студента уже есть логин. Забытый пароль восстанавливается через ' +
          'POST /auth/password/forgot',
      );
    }

    // Приглашать заблокированного бессмысленно: свежий аккаунт был бы активным
    // при профиле со статусом «Block», то есть блокировка снялась бы сама.
    if (student.status === StudentStatus.BLOCK) {
      throw new BusinessRuleException(
        'Студент заблокирован: снимите блокировку прежде, чем выдавать логин',
        { status: student.status },
      );
    }

    const email = dto.email ?? student.email;
    if (email === null || email === undefined || email === '') {
      throw new BusinessRuleException(
        'У студента не указан email, а приглашение отправляется письмом — ' +
          'передайте адрес в теле запроса или заполните карточку',
        { email: 'обязателен для приглашения' },
      );
    }

    await this.assertAccountFree(student.phone, email);

    const locale = dto.locale ?? Locale.RU;
    const account = await this.repository.createAccount({
      studentId,
      // Логин — контактный телефон профиля (ТЗ 3.1). Он уже в E.164: карточка
      // студента нормализует номер при записи.
      phone: student.phone,
      email,
      passwordHash: await this.passwords.hash(
        randomBytes(UNUSABLE_SECRET_BYTES).toString('base64url'),
      ),
      locale,
      // Переданная почта попадает и в карточку: иначе адрес логина и адрес
      // в профиле разошлись бы уже на втором приглашении.
      updateStudentEmail: dto.email !== undefined && dto.email !== student.email,
    });

    const code = await this.passwordReset.issueCode(account.id);
    await this.mailer.send(
      renderStudentInviteEmail({
        to: email,
        locale,
        login: account.phone,
        code,
        ttlSeconds: PASSWORD_RESET_TTL_SECONDS,
      }),
    );

    const fullName = nameOf(student);
    this.logger.log(
      `Приглашён студент ${fullName} (${studentId}): выдан аккаунт ${account.id}; ` +
        `выполнил аккаунт ${actorAccountId}`,
    );

    return { id: studentId, fullName, account, codeSentTo: email };
  }

  private async require(id: string): Promise<StudentAccessRow> {
    const student = await this.repository.findStudent(id);
    if (!student) {
      throw new NotFoundException('Студент не найден');
    }

    return student;
  }

  /**
   * Возврат доступа. Статус до блокировки нигде не хранится, поэтому выводится
   * заново из членств; профиль, который блокировкой не помечался, не трогаем —
   * иначе разблокировка переписывала бы статус, к ней не относящийся.
   */
  private statusForUnblock(student: StudentAccessRow): StudentStatus {
    return student.status === StudentStatus.BLOCK
      ? statusAfterUnblock(student.groups)
      : student.status;
  }

  /**
   * Телефон и email аккаунта уникальны (ТЗ 3.1). Проверка до вставки — чтобы
   * назвать причину: `P2002` вернулся бы обезличенным «запись уже существует»,
   * и оператор не понял бы, что именно занято.
   */
  private async assertAccountFree(phone: string, email: string): Promise<void> {
    const twin = await this.repository.findAccountByPhoneOrEmail(phone, email);
    if (!twin) return;

    const owner = twin.type === AccountType.EMPLOYEE ? 'сотрудника' : 'другого студента';

    throw new ConflictException(
      twin.phone === phone
        ? `Телефон ${phone} уже является логином ${owner}`
        : `Email ${email} уже занят аккаунтом ${owner}`,
    );
  }
}

const nameOf = (student: { firstName: string; lastName: string }): string =>
  `${student.lastName} ${student.firstName}`;
