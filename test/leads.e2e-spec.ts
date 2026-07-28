import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountType, DirectoryStatus, Gender, LeadType, Prisma } from '@prisma/client';
import request from 'supertest';

import { AuthModule } from 'src/auth/auth.module';
import { AuthRepository } from 'src/auth/auth.repository';
import { TokenService } from 'src/auth/token.service';
import { configureApp } from 'src/bootstrap';
import { AllExceptionsFilter, SortOrder, TransformResponseInterceptor } from 'src/common';
import { AppConfigModule } from 'src/config/config.module';
import { CouponsModule } from 'src/coupons/coupons.module';
import type {
  CouponListParams,
  CouponRow,
  CouponsRepository as CouponsRepositoryType,
  CouponUpdateInput,
  CouponWriteInput,
  CourseCandidate,
} from 'src/coupons/coupons.repository';
import { CouponsRepository } from 'src/coupons/coupons.repository';
import { CouponSortField } from 'src/coupons/dto';
import { LeadSortField } from 'src/leads/dto';
import { LeadsModule } from 'src/leads/leads.module';
import type {
  LeadFilter,
  LeadListParams,
  LeadRow,
  LeadTransferResult,
  LeadTransferWrite,
  LeadUpdateInput,
  LeadWriteInput,
} from 'src/leads/leads.repository';
import { LeadsRepository } from 'src/leads/leads.repository';
import type { ExistingStudentProfile, LeadForTransfer } from 'src/leads/leads-transfer';
import { LoggerModule } from 'src/logger/logger.module';
import { MailerModule } from 'src/mailer/mailer.module';
import { PhoneModule } from 'src/phone/phone.module';
import { RbacModule } from 'src/rbac/rbac.module';
import { RbacRepository } from 'src/rbac/rbac.repository';
import { buildOpenApiDocument } from 'src/swagger';

/** `{ data }` ответа с ожидаемым типом — тела supertest типизированы как `any`. */
const dataOf = <T>(response: { body: unknown }): T => (response.body as { data: T }).data;
const metaOf = (response: { body: unknown }): { total: number; page: number; limit: number } =>
  (response.body as { meta: { total: number; page: number; limit: number } }).meta;

/** Права аккаунта в памяти вместо трёх таблиц RBAC (как в остальных наборах). */
class InMemoryRbacRepository {
  private readonly codesByAccount = new Map<string, string[]>();

  grant(accountId: string, codes: string[]): void {
    this.codesByAccount.set(accountId, codes);
  }

  findAccountPermissionCodes(accountId: string): Promise<{ code: string }[]> {
    return Promise.resolve((this.codesByAccount.get(accountId) ?? []).map((code) => ({ code })));
  }

  findAllPermissions(): Promise<[]> {
    return Promise.resolve([]);
  }

  createPermissions(): Promise<number> {
    return Promise.resolve(0);
  }

  updatePermission(): Promise<void> {
    return Promise.resolve();
  }

  syncSystemPosition(): Promise<number> {
    return Promise.resolve(0);
  }
}

interface StoredCourse {
  id: string;
  title: string;
}

interface StoredBranch {
  id: string;
  name: string;
}

/**
 * Профиль студента в том объёме, в каком его знает перевод лида: телефон
 * (уникален, на нём держится «привязать, а не завести второй»), ФИО и поля,
 * которые перевод переносит из обращения.
 */
interface StoredStudent {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string | null;
  birthDate: Date | null;
  gender: Gender | null;
  branchId: string | null;
}

const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

/**
 * Маркетинговый контур в памяти: курсы, филиалы, купоны и лиды **вместе**.
 *
 * Одно хранилище на два репозитория (`LeadsRepository` и `CouponsRepository`)
 * не для удобства: правила модулей связывают эти сущности между собой. Купон
 * ссылается на курсы, лид ссылается на купон, а число обещанных лидов держит
 * купон от удаления — разведённые заглушки проверяли бы каждая своё, а не то,
 * что связывает их. Отбор и счётчики **повторяют правила репозиториев**,
 * а не подставляют готовые числа.
 */
class InMemoryMarketingStore {
  readonly courses = new Map<string, StoredCourse>();
  readonly branches = new Map<string, StoredBranch>();
  readonly coupons = new Map<string, CouponRow>();
  readonly couponCourses = new Map<string, string[]>();
  readonly leads = new Map<string, LeadRow>();
  /** Профили студентов: сюда пишет перевод, отсюда же он узнаёт о занятом телефоне. */
  readonly students = new Map<string, StoredStudent>();

  addStudent(overrides: Partial<StoredStudent> = {}): StoredStudent {
    const student: StoredStudent = {
      id: randomUUID(),
      firstName: 'Нигина',
      lastName: 'Каримова',
      phone: '+992901234567',
      email: null,
      birthDate: null,
      gender: null,
      branchId: null,
      ...overrides,
    };
    this.students.set(student.id, student);

    return student;
  }

  addCourse(title = 'Frontend'): StoredCourse {
    const course = { id: randomUUID(), title };
    this.courses.set(course.id, course);

    return course;
  }

  addBranch(name = 'Sadbarg'): StoredBranch {
    const branch = { id: randomUUID(), name };
    this.branches.set(branch.id, branch);

    return branch;
  }

  addCoupon(overrides: Partial<CouponRow> = {}, courseIds: string[] = []): CouponRow {
    const coupon: CouponRow = {
      id: randomUUID(),
      name: `COUPON-${String(this.coupons.size + 1)}`,
      description: null,
      amount: new Prisma.Decimal('100.00'),
      validFrom: null,
      validTo: null,
      status: DirectoryStatus.ACTIVE,
      createdAt: new Date(Date.now() + this.coupons.size),
      courses: [],
      _count: { leads: 0 },
      ...overrides,
    };
    this.coupons.set(coupon.id, coupon);
    this.couponCourses.set(coupon.id, courseIds);

    return coupon;
  }

  addLead(overrides: Partial<LeadRow> = {}): LeadRow {
    const lead: LeadRow = {
      id: randomUUID(),
      firstName: 'Нигина',
      lastName: 'Каримова',
      phone: '+992901234567',
      email: null,
      birthDate: null,
      gender: null,
      occupation: null,
      enrollMonth: null,
      lessonTimeMinute: null,
      notes: null,
      source: null,
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
      type: LeadType.LEAD,
      becameClientAt: null,
      convertedStudentId: null,
      convertedAt: null,
      createdAt: new Date(Date.now() + this.leads.size),
      course: null,
      coupon: null,
      branch: null,
      ...overrides,
    };
    this.leads.set(lead.id, lead);

    return lead;
  }

  // ─────────────────────────────── Купоны ───────────────────────────────

  /** Строка купона собирается на выдаче — как `select` с `_count` у Prisma. */
  private couponRow(id: string): CouponRow | null {
    const coupon = this.coupons.get(id);
    if (!coupon) return null;

    const courseIds = this.couponCourses.get(id) ?? [];

    return {
      ...coupon,
      courses: courseIds
        .map((courseId) => this.courses.get(courseId))
        .filter((course): course is StoredCourse => course !== undefined)
        .sort((a, b) => a.title.localeCompare(b.title))
        .map((course) => ({ course })),
      _count: {
        leads: [...this.leads.values()].filter((lead) => lead.coupon?.id === id).length,
      },
    };
  }

  private validOn(coupon: CouponRow, on: Date): boolean {
    return (
      coupon.status === DirectoryStatus.ACTIVE &&
      (coupon.validFrom === null || coupon.validFrom.getTime() <= on.getTime()) &&
      (coupon.validTo === null || coupon.validTo.getTime() >= on.getTime())
    );
  }

  findMany(params: CouponListParams): Promise<{ rows: CouponRow[]; total: number }> {
    const search = params.search?.toLowerCase();

    const matched = [...this.coupons.keys()]
      .map((id) => this.couponRow(id)!)
      .filter((row) => params.status === undefined || row.status === params.status)
      .filter((row) => {
        if (params.courseId === undefined) return true;
        const courseIds = this.couponCourses.get(row.id) ?? [];

        // Купон «на все курсы» (пустой набор) действует и на этот курс тоже.
        return courseIds.length === 0 || courseIds.includes(params.courseId);
      })
      .filter(
        (row) =>
          params.currentlyValid === undefined ||
          this.validOn(row, params.on) === params.currentlyValid,
      )
      .filter(
        (row) =>
          search === undefined ||
          row.name.toLowerCase().includes(search) ||
          (row.description?.toLowerCase().includes(search) ?? false),
      )
      .sort((a, b) => {
        const asc =
          params.sort === CouponSortField.Amount
            ? Number(a.amount) - Number(b.amount)
            : params.sort === CouponSortField.CreatedAt
              ? a.createdAt.getTime() - b.createdAt.getTime()
              : params.sort === CouponSortField.ValidTo
                ? nullsLast(a.validTo, b.validTo)
                : a.name.localeCompare(b.name);

        return params.order === SortOrder.Asc ? asc : -asc;
      });

    return Promise.resolve({
      rows: matched.slice(params.skip, params.skip + params.take),
      total: matched.length,
    });
  }

  findById(id: string): Promise<CouponRow | null> {
    return Promise.resolve(this.couponRow(id));
  }

  findByName(name: string): Promise<{ id: string; name: string } | null> {
    const found = [...this.coupons.values()].find(
      (row) => row.name.toLowerCase() === name.toLowerCase(),
    );

    return Promise.resolve(found ? { id: found.id, name: found.name } : null);
  }

  findCourses(ids: string[]): Promise<CourseCandidate[]> {
    return Promise.resolve(
      ids
        .map((id) => this.courses.get(id))
        .filter((course): course is StoredCourse => course !== undefined),
    );
  }

  create(input: CouponWriteInput, courseIds: string[]): Promise<CouponRow> {
    const coupon = this.addCoupon(
      {
        name: input.name,
        description: input.description,
        amount: new Prisma.Decimal(input.amount.toFixed(2)),
        validFrom: input.validFrom,
        validTo: input.validTo,
        status: input.status ?? DirectoryStatus.ACTIVE,
      },
      courseIds,
    );

    return Promise.resolve(this.couponRow(coupon.id)!);
  }

  update(id: string, input: CouponUpdateInput, courseIds?: string[]): Promise<CouponRow> {
    const coupon = this.coupons.get(id)!;

    this.coupons.set(id, {
      ...coupon,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.amount === undefined
        ? {}
        : { amount: new Prisma.Decimal(input.amount.toFixed(2)) }),
      ...(input.validFrom === undefined ? {} : { validFrom: input.validFrom }),
      ...(input.validTo === undefined ? {} : { validTo: input.validTo }),
      ...(input.status === undefined ? {} : { status: input.status }),
    });

    // Переданный список заменяет набор целиком — как `deleteMany` + `createMany`.
    if (courseIds !== undefined) this.couponCourses.set(id, courseIds);

    return Promise.resolve(this.couponRow(id)!);
  }

  delete(id: string): Promise<void> {
    this.coupons.delete(id);
    // Связка каскадится вместе с купоном.
    this.couponCourses.delete(id);

    return Promise.resolve();
  }

  // ──────────────────────────────── Лиды ────────────────────────────────

  /**
   * Отбор строк — один на постраничный список и на выгрузку, как `whereOf`
   * в репозитории: если бы файл фильтровался своим кодом, тест «выгрузка
   * показывает то же, что экран» проверял бы совпадение двух реализаций,
   * а не правило.
   */
  private matchLeads(filter: LeadFilter): LeadRow[] {
    const search = filter.search?.toLowerCase();

    return [...this.leads.values()]
      .filter((row) => filter.type === undefined || row.type === filter.type)
      .filter((row) => filter.courseId === undefined || row.course?.id === filter.courseId)
      .filter((row) => filter.branchId === undefined || row.branch?.id === filter.branchId)
      .filter((row) => filter.couponId === undefined || row.coupon?.id === filter.couponId)
      .filter(
        (row) =>
          filter.enrollMonth === undefined ||
          row.enrollMonth?.getTime() === filter.enrollMonth.getTime(),
      )
      .filter(
        (row) =>
          filter.converted === undefined || (row.convertedStudentId !== null) === filter.converted,
      )
      .filter(
        (row) => filter.from === undefined || row.createdAt.getTime() >= filter.from.getTime(),
      )
      .filter((row) => filter.to === undefined || row.createdAt.getTime() < filter.to.getTime())
      .filter(
        (row) =>
          search === undefined ||
          row.firstName.toLowerCase().includes(search) ||
          row.lastName.toLowerCase().includes(search) ||
          row.phone.includes(search) ||
          (row.email?.toLowerCase().includes(search) ?? false) ||
          (row.source?.toLowerCase().includes(search) ?? false) ||
          (row.utmCampaign?.toLowerCase().includes(search) ?? false),
      );
  }

  findManyLeads(params: LeadListParams): Promise<{ rows: LeadRow[]; total: number }> {
    const matched = this.matchLeads(params).sort((a, b) => {
      const asc =
        params.sort === LeadSortField.Name
          ? a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName)
          : params.sort === LeadSortField.EnrollMonth
            ? nullsLast(a.enrollMonth, b.enrollMonth)
            : a.createdAt.getTime() - b.createdAt.getTime();

      return params.order === SortOrder.Asc ? asc : -asc;
    });

    return Promise.resolve({
      rows: matched.slice(params.skip, params.skip + params.take),
      total: matched.length,
    });
  }

  findLeadById(id: string): Promise<LeadRow | null> {
    return Promise.resolve(this.leads.get(id) ?? null);
  }

  countByPhone(phone: string, exceptId?: string): Promise<number> {
    return Promise.resolve(
      [...this.leads.values()].filter((row) => row.phone === phone && row.id !== exceptId).length,
    );
  }

  createLead(input: LeadWriteInput): Promise<LeadRow> {
    return Promise.resolve(
      this.addLead({
        ...input,
        gender: input.gender ?? null,
        type: input.type ?? LeadType.LEAD,
        becameClientAt: input.becameClientAt ?? null,
        course: this.courseRef(input.courseId),
        coupon: this.couponRef(input.couponId),
        branch: this.branchRef(input.branchId),
      }),
    );
  }

  updateLead(id: string, input: LeadUpdateInput): Promise<LeadRow> {
    const lead = this.leads.get(id)!;
    const defined = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    ) as Partial<LeadRow> & Partial<LeadWriteInput>;

    const next: LeadRow = {
      ...lead,
      ...defined,
      ...('courseId' in defined ? { course: this.courseRef(input.courseId ?? null) } : {}),
      ...('couponId' in defined ? { coupon: this.couponRef(input.couponId ?? null) } : {}),
      ...('branchId' in defined ? { branch: this.branchRef(input.branchId ?? null) } : {}),
    };
    this.leads.set(id, next);

    return Promise.resolve(next);
  }

  deleteLead(id: string): Promise<void> {
    this.leads.delete(id);

    return Promise.resolve();
  }

  // ───────────────────── Выгрузка и перевод (ТЗ 5.7) ─────────────────────

  /** Без окна страницы и с фиксированным порядком — как в репозитории. */
  findAllForExport(filter: LeadFilter): Promise<LeadRow[]> {
    return Promise.resolve(
      this.matchLeads(filter).sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id),
      ),
    );
  }

  findManyForTransfer(ids: string[]): Promise<LeadForTransfer[]> {
    return Promise.resolve(
      ids.flatMap((id) => {
        const lead = this.leads.get(id);
        if (!lead) return [];

        return [
          {
            id: lead.id,
            firstName: lead.firstName,
            lastName: lead.lastName,
            phone: lead.phone,
            email: lead.email,
            birthDate: lead.birthDate,
            gender: lead.gender,
            branchId: lead.branch?.id ?? null,
            convertedStudentId: lead.convertedStudentId,
          },
        ];
      }),
    );
  }

  findStudentsByPhones(phones: string[]): Promise<ExistingStudentProfile[]> {
    return Promise.resolve(
      [...this.students.values()]
        .filter((student) => phones.includes(student.phone))
        .map((student) => ({
          id: student.id,
          phone: student.phone,
          lastName: student.lastName,
          firstName: student.firstName,
          // «Профиль уже занят другим обращением» выводится из самой ссылки,
          // а не из отдельного поля: `Lead.convertedStudentId` уникален.
          leadOriginId:
            [...this.leads.values()].find((lead) => lead.convertedStudentId === student.id)?.id ??
            null,
        })),
    );
  }

  transfer(writes: readonly LeadTransferWrite[], now: Date): Promise<LeadTransferResult[]> {
    return Promise.resolve(
      writes.map((write) => {
        const studentId = write.studentId ?? this.addStudent(write.profile).id;
        const lead = this.leads.get(write.leadId)!;

        this.leads.set(write.leadId, { ...lead, convertedStudentId: studentId, convertedAt: now });

        return { leadId: write.leadId, studentId };
      }),
    );
  }

  findCourse(id: string): Promise<StoredCourse | null> {
    return Promise.resolve(this.courses.get(id) ?? null);
  }

  findCoupon(id: string): Promise<{ id: string; name: string } | null> {
    const coupon = this.coupons.get(id);

    return Promise.resolve(coupon ? { id: coupon.id, name: coupon.name } : null);
  }

  findBranch(id: string): Promise<StoredBranch | null> {
    return Promise.resolve(this.branches.get(id) ?? null);
  }

  private courseRef(id: string | null | undefined): { id: string; title: string } | null {
    return id === null || id === undefined ? null : (this.courses.get(id) ?? null);
  }

  private couponRef(id: string | null | undefined): { id: string; name: string } | null {
    const coupon = id === null || id === undefined ? undefined : this.coupons.get(id);

    return coupon ? { id: coupon.id, name: coupon.name } : null;
  }

  private branchRef(id: string | null | undefined): StoredBranch | null {
    return id === null || id === undefined ? null : (this.branches.get(id) ?? null);
  }
}

/** Пустое значение уезжает в конец при любом направлении — как `nulls: 'last'`. */
const nullsLast = (a: Date | null, b: Date | null): number => {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;

  return a.getTime() - b.getTime();
};

/** Репозиторий лидов поверх общего хранилища: имена методов отличаются. */
const leadsRepositoryOf = (store: InMemoryMarketingStore) => ({
  findMany: (params: LeadListParams) => store.findManyLeads(params),
  findById: (id: string) => store.findLeadById(id),
  countByPhone: (phone: string, exceptId?: string) => store.countByPhone(phone, exceptId),
  create: (input: LeadWriteInput) => store.createLead(input),
  update: (id: string, input: LeadUpdateInput) => store.updateLead(id, input),
  delete: (id: string) => store.deleteLead(id),
  findAllForExport: (filter: LeadFilter) => store.findAllForExport(filter),
  findManyForTransfer: (ids: string[]) => store.findManyForTransfer(ids),
  findStudentsByPhones: (phones: string[]) => store.findStudentsByPhones(phones),
  transfer: (writes: readonly LeadTransferWrite[], now: Date) => store.transfer(writes, now),
  findCourse: (id: string) => store.findCourse(id),
  findCoupon: (id: string) => store.findCoupon(id),
  findBranch: (id: string) => store.findBranch(id),
});

interface CouponBody {
  id: string;
  name: string;
  amount: number;
  validFrom: string | null;
  validTo: string | null;
  status: DirectoryStatus;
  courses: { id: string; title: string }[];
  isCurrentlyValid: boolean;
  leadsCount: number;
}

interface LeadBody {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  enrollMonth: string | null;
  lessonTime: string | null;
  course: { id: string; name: string } | null;
  coupon: { id: string; name: string } | null;
  branch: { id: string; name: string } | null;
  type: LeadType;
  becameClientAt: string | null;
  conversion: { converted: boolean; studentId: string | null; convertedAt: string | null };
  utm: { source: string | null; medium: string | null; campaign: string | null };
  duplicatePhoneCount?: number;
}

interface TransferBody {
  transferred: { leadId: string; name: string; studentId: string; action: string }[];
  created: number;
  linked: number;
}

const LEADS_VIEWS = 'Permission.Leads.Views';
const LEADS_CREATE = 'Permission.Leads.Create';
const LEADS_UPDATE = 'Permission.Leads.Update';
const LEADS_DELETE = 'Permission.Leads.Delete';
const LEADS_TRANSFER = 'Permission.Leads.Transfer';
const LEADS_EXPORT = 'Permission.Leads.Export';
const COUPONS_VIEWS = 'Permission.Coupons.Views';
const COUPONS_CREATE = 'Permission.Coupons.Create';
const COUPONS_UPDATE = 'Permission.Coupons.Update';
const COUPONS_DELETE = 'Permission.Coupons.Delete';
const ALL = [
  LEADS_VIEWS,
  LEADS_CREATE,
  LEADS_UPDATE,
  LEADS_DELETE,
  LEADS_TRANSFER,
  LEADS_EXPORT,
  COUPONS_VIEWS,
  COUPONS_CREATE,
  COUPONS_UPDATE,
  COUPONS_DELETE,
];

const lead = (overrides: object = {}) => ({
  firstName: 'Нигина',
  lastName: 'Каримова',
  phone: '+992901234567',
  ...overrides,
});

describe('Лиды и купоны (e2e, хранилище в памяти)', () => {
  let app: INestApplication;
  let store: InMemoryMarketingStore;
  let rbac: InMemoryRbacRepository;
  let tokens: TokenService;

  beforeEach(async () => {
    store = new InMemoryMarketingStore();
    rbac = new InMemoryRbacRepository();

    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        LoggerModule,
        MailerModule,
        PhoneModule,
        AuthModule,
        RbacModule,
        LeadsModule,
        CouponsModule,
      ],
      providers: [
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_INTERCEPTOR, useClass: TransformResponseInterceptor },
      ],
    })
      // AuthModule нужен целиком: он приносит глобальный `JwtAuthGuard`.
      .overrideProvider(AuthRepository)
      .useValue({})
      .overrideProvider(LeadsRepository)
      .useValue(leadsRepositoryOf(store))
      .overrideProvider(CouponsRepository)
      .useValue(store as unknown as CouponsRepositoryType)
      .overrideProvider(RbacRepository)
      .useValue(rbac)
      .compile();

    tokens = moduleRef.get(TokenService, { strict: false });

    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
  });

  const tokenWith = async (codes: string[]): Promise<string> => {
    const accountId = randomUUID();
    rbac.grant(accountId, codes);
    const { accessToken } = await tokens.issuePair({
      sub: accountId,
      sid: randomUUID(),
      type: AccountType.EMPLOYEE,
    });

    return accessToken;
  };

  const studentToken = async (): Promise<string> =>
    (await tokens.issuePair({ sub: randomUUID(), sid: randomUUID(), type: AccountType.STUDENT }))
      .accessToken;

  const server = () => request(app.getHttpServer());
  const get = (url: string, token: string) =>
    server().get(url).set('Authorization', `Bearer ${token}`);
  const post = (url: string, token: string, payload: object) =>
    server().post(url).set('Authorization', `Bearer ${token}`).send(payload);
  const put = (url: string, token: string, payload: object) =>
    server().put(url).set('Authorization', `Bearer ${token}`).send(payload);
  const del = (url: string, token: string) =>
    server().delete(url).set('Authorization', `Bearer ${token}`);

  // ───────────────────────────── Доступ ─────────────────────────────

  describe('Доступ', () => {
    it('401 без токена на лидах и на купонах', async () => {
      await server().get('/api/v1/leads').expect(401);
      await server().get('/api/v1/coupons').expect(401);
    });

    it('403 студенту: маркетинговый контур — не то, что видит студент', async () => {
      const token = await studentToken();

      await get('/api/v1/leads', token).expect(403);
      await get('/api/v1/coupons', token).expect(403);
    });

    it('403 сотруднику без прав', async () => {
      const token = await tokenWith([]);

      await get('/api/v1/leads', token).expect(403);
      await get('/api/v1/coupons', token).expect(403);
    });

    it('право на лидов купоны не открывает, и наоборот', async () => {
      await get('/api/v1/coupons', await tokenWith([LEADS_VIEWS])).expect(403);
      await get('/api/v1/leads', await tokenWith([COUPONS_VIEWS])).expect(403);
    });

    it('право на просмотр не даёт создавать, а на создание — удалять', async () => {
      const created = store.addLead();

      await post('/api/v1/leads', await tokenWith([LEADS_VIEWS]), lead()).expect(403);
      await del(`/api/v1/leads/${created.id}`, await tokenWith([LEADS_CREATE])).expect(403);
    });

    it('право на правку лида не даёт править купоны', async () => {
      const coupon = store.addCoupon();

      await put(`/api/v1/coupons/${coupon.id}`, await tokenWith([LEADS_UPDATE]), {
        amount: 1,
      }).expect(403);
    });
  });

  // ───────────────────────────── Купоны ─────────────────────────────

  describe('Купоны (ТЗ 5.7)', () => {
    it('заводит купон с суммой в сомони, периодом и мультивыбором курсов', async () => {
      const token = await tokenWith(ALL);
      const frontend = store.addCourse('Frontend');
      const backend = store.addCourse('Backend');

      const response = await post('/api/v1/coupons', token, {
        name: 'OSEN-2026',
        amount: 250.5,
        validFrom: '2026-09-01',
        validTo: '2026-11-30',
        courseIds: [frontend.id, backend.id],
      }).expect(201);

      const body = dataOf<CouponBody>(response);
      expect(body).toMatchObject({
        name: 'OSEN-2026',
        amount: 250.5,
        validFrom: '2026-09-01',
        validTo: '2026-11-30',
        leadsCount: 0,
      });
      // Курсы отдаются по алфавиту — как `orderBy: { course: { title } }`.
      expect(body.courses.map((course) => course.title)).toEqual(['Backend', 'Frontend']);
    });

    it('копейки не теряются: 1234.56 остаётся 1234.56', async () => {
      const response = await post('/api/v1/coupons', await tokenWith(ALL), {
        name: 'PRECISE',
        amount: 1234.56,
      }).expect(201);

      expect(dataOf<CouponBody>(response).amount).toBe(1234.56);
    });

    it('купон без курсов действует на все: пустой список — не сломанная запись', async () => {
      const token = await tokenWith(ALL);
      const frontend = store.addCourse('Frontend');

      await post('/api/v1/coupons', token, { name: 'ALL-COURSES', amount: 100 }).expect(201);

      // Фильтр по курсу обязан его найти: иначе он отвечал бы на вопрос
      // «что перечислено поимённо», а не «чем можно воспользоваться».
      const response = await get(`/api/v1/coupons?courseId=${frontend.id}`, token).expect(200);
      expect(dataOf<CouponBody[]>(response).map((row) => row.name)).toEqual(['ALL-COURSES']);
    });

    it('фильтр по курсу отбирает и поимённые купоны, и купоны «на все курсы»', async () => {
      const token = await tokenWith(ALL);
      const frontend = store.addCourse('Frontend');
      const backend = store.addCourse('Backend');
      store.addCoupon({ name: 'FRONT-ONLY' }, [frontend.id]);
      store.addCoupon({ name: 'BACK-ONLY' }, [backend.id]);
      store.addCoupon({ name: 'ALL' }, []);

      const response = await get(`/api/v1/coupons?courseId=${frontend.id}`, token).expect(200);

      expect(
        dataOf<CouponBody[]>(response)
          .map((row) => row.name)
          .sort(),
      ).toEqual(['ALL', 'FRONT-ONLY']);
    });

    it('409 на тёзку без учёта регистра — купон не создан', async () => {
      const token = await tokenWith(ALL);
      store.addCoupon({ name: 'OSEN-2026' });

      await post('/api/v1/coupons', token, { name: 'osen-2026', amount: 100 }).expect(409);

      expect(store.coupons.size).toBe(1);
    });

    it('400 на конец периода раньше начала — купон не создан', async () => {
      const token = await tokenWith(ALL);

      await post('/api/v1/coupons', token, {
        name: 'BROKEN',
        amount: 100,
        validFrom: '2026-11-30',
        validTo: '2026-09-01',
      }).expect(400);

      expect(store.coupons.size).toBe(0);
    });

    it('422 на несуществующий курс — перечисляются только недостающие', async () => {
      const token = await tokenWith(ALL);
      const frontend = store.addCourse('Frontend');
      const ghost = randomUUID();

      const response = await post('/api/v1/coupons', token, {
        name: 'OSEN',
        amount: 100,
        courseIds: [frontend.id, ghost],
      }).expect(422);

      expect(
        (response.body as { error: { details: { courseIds: string[] } } }).error.details,
      ).toEqual({ courseIds: [ghost] });
      expect(store.coupons.size).toBe(0);
    });

    it('`courseIds` в правке заменяет набор целиком, пустой список — «на все курсы»', async () => {
      const token = await tokenWith(ALL);
      const frontend = store.addCourse('Frontend');
      const backend = store.addCourse('Backend');
      const coupon = store.addCoupon({ name: 'OSEN' }, [frontend.id]);

      const replaced = await put(`/api/v1/coupons/${coupon.id}`, token, {
        courseIds: [backend.id],
      }).expect(200);
      expect(dataOf<CouponBody>(replaced).courses.map((c) => c.title)).toEqual(['Backend']);

      const cleared = await put(`/api/v1/coupons/${coupon.id}`, token, { courseIds: [] }).expect(
        200,
      );
      expect(dataOf<CouponBody>(cleared).courses).toEqual([]);
    });

    it('не переданный `courseIds` набор не трогает', async () => {
      const token = await tokenWith(ALL);
      const frontend = store.addCourse('Frontend');
      const coupon = store.addCoupon({ name: 'OSEN' }, [frontend.id]);

      const response = await put(`/api/v1/coupons/${coupon.id}`, token, { amount: 500 }).expect(
        200,
      );

      expect(dataOf<CouponBody>(response)).toMatchObject({ amount: 500 });
      expect(dataOf<CouponBody>(response).courses.map((c) => c.title)).toEqual(['Frontend']);
    });

    it('«действует сегодня» считается по статусу и периоду', async () => {
      const token = await tokenWith(ALL);
      store.addCoupon({ name: 'EXPIRED', validTo: day('2020-01-01') });
      store.addCoupon({ name: 'DISABLED', status: DirectoryStatus.INACTIVE });
      store.addCoupon({ name: 'FOREVER' });

      const valid = await get('/api/v1/coupons?currentlyValid=true', token).expect(200);
      expect(dataOf<CouponBody[]>(valid).map((row) => row.name)).toEqual(['FOREVER']);

      const invalid = await get('/api/v1/coupons?currentlyValid=false', token).expect(200);
      expect(
        dataOf<CouponBody[]>(invalid)
          .map((row) => row.name)
          .sort(),
      ).toEqual(['DISABLED', 'EXPIRED']);
    });

    it('пустая строка снимает границу периода', async () => {
      const token = await tokenWith(ALL);
      const coupon = store.addCoupon({ validTo: day('2026-11-30') });

      const response = await put(`/api/v1/coupons/${coupon.id}`, token, { validTo: '' }).expect(
        200,
      );

      expect(dataOf<CouponBody>(response).validTo).toBeNull();
    });

    it('новая граница сверяется со сроком из БД (400), купон не изменён', async () => {
      const token = await tokenWith(ALL);
      const coupon = store.addCoupon({ validFrom: day('2026-11-01') });

      await put(`/api/v1/coupons/${coupon.id}`, token, { validTo: '2026-09-01' }).expect(400);

      expect(store.coupons.get(coupon.id)?.validTo).toBeNull();
    });

    it('список постраничный, по алфавиту, с фильтром статуса', async () => {
      const token = await tokenWith(ALL);
      store.addCoupon({ name: 'ZIMA', status: DirectoryStatus.INACTIVE });
      store.addCoupon({ name: 'OSEN' });

      const all = await get('/api/v1/coupons', token).expect(200);
      expect(dataOf<CouponBody[]>(all).map((row) => row.name)).toEqual(['OSEN', 'ZIMA']);
      expect(metaOf(all)).toMatchObject({ total: 2, page: 1, limit: 20 });

      const active = await get(`/api/v1/coupons?status=${DirectoryStatus.ACTIVE}`, token).expect(
        200,
      );
      expect(dataOf<CouponBody[]>(active).map((row) => row.name)).toEqual(['OSEN']);
    });

    it('400 на неизвестное поле сортировки и не-UUID в пути', async () => {
      const token = await tokenWith(ALL);

      await get('/api/v1/coupons?sort=amountish', token).expect(400);
      await get('/api/v1/coupons/not-a-uuid', token).expect(400);
    });

    it('404 на неизвестный купон', async () => {
      await get(`/api/v1/coupons/${randomUUID()}`, await tokenWith(ALL)).expect(404);
    });

    it('удаляет купон, который никому не обещан', async () => {
      const token = await tokenWith(ALL);
      const coupon = store.addCoupon({ name: 'OSEN' });

      await del(`/api/v1/coupons/${coupon.id}`, token).expect(200);

      expect(store.coupons.size).toBe(0);
    });
  });

  // ────────────────────────────── Лиды ──────────────────────────────

  describe('Лиды (ТЗ 5.7)', () => {
    it('заводит лида со всеми полями формы ТЗ 5.7', async () => {
      const token = await tokenWith(ALL);
      const course = store.addCourse('Frontend');
      const branch = store.addBranch('Sadbarg');
      const coupon = store.addCoupon({ name: 'OSEN-2026' });

      const response = await post(
        '/api/v1/leads',
        token,
        lead({
          phone: '901234567',
          email: 'Nigina@Mail.TJ',
          birthDate: '2004-05-17',
          gender: Gender.FEMALE,
          occupation: 'студент',
          enrollMonth: '2026-09',
          courseId: course.id,
          lessonTime: '18:30',
          notes: 'перезвонить после 18:00',
          source: 'Instagram',
          utmSource: 'instagram',
          utmMedium: 'cpc',
          utmCampaign: 'osen-2026',
          couponId: coupon.id,
          branchId: branch.id,
        }),
      ).expect(201);

      expect(dataOf<LeadBody>(response)).toMatchObject({
        // Телефон приведён к E.164, почта — к нижнему регистру.
        phone: '+992901234567',
        enrollMonth: '2026-09',
        lessonTime: '18:30',
        course: { id: course.id, name: 'Frontend' },
        coupon: { id: coupon.id, name: 'OSEN-2026' },
        branch: { id: branch.id, name: 'Sadbarg' },
        type: LeadType.LEAD,
        becameClientAt: null,
        utm: { source: 'instagram', medium: 'cpc', campaign: 'osen-2026' },
        conversion: { converted: false, studentId: null, convertedAt: null },
        duplicatePhoneCount: 0,
      });
    });

    it('повторное обращение того же человека заводится и помечается подсказкой', async () => {
      const token = await tokenWith(ALL);
      store.addLead({ phone: '+992901234567' });

      const response = await post('/api/v1/leads', token, lead()).expect(201);

      expect(dataOf<LeadBody>(response).duplicatePhoneCount).toBe(1);
      expect(store.leads.size).toBe(2);
    });

    it('подсказка о дублях не считает самого себя', async () => {
      const response = await post('/api/v1/leads', await tokenWith(ALL), lead()).expect(201);

      expect(dataOf<LeadBody>(response).duplicatePhoneCount).toBe(0);
    });

    it('422 на несуществующий курс, купон и филиал — лид не заведён', async () => {
      const token = await tokenWith(ALL);

      await post('/api/v1/leads', token, lead({ courseId: randomUUID() })).expect(422);
      await post('/api/v1/leads', token, lead({ couponId: randomUUID() })).expect(422);
      await post('/api/v1/leads', token, lead({ branchId: randomUUID() })).expect(422);

      expect(store.leads.size).toBe(0);
    });

    it('400 на негодное тело — лид не заведён', async () => {
      const token = await tokenWith(ALL);

      await post('/api/v1/leads', token, lead({ phone: 'не телефон' })).expect(400);
      await post('/api/v1/leads', token, lead({ birthDate: '2004-02-30' })).expect(400);
      await post('/api/v1/leads', token, lead({ enrollMonth: '2026-9' })).expect(400);
      await post('/api/v1/leads', token, lead({ lessonTime: '25:00' })).expect(400);
      await post('/api/v1/leads', token, lead({ email: 'не почта' })).expect(400);
      await post('/api/v1/leads', token, lead({ firstName: 'Я' })).expect(400);
      await post('/api/v1/leads', token, lead({ becameClientAt: '2026-09-01' })).expect(400);

      expect(store.leads.size).toBe(0);
    });

    it('перевод в клиенты проставляет дату, возврат в лиды — снимает', async () => {
      const token = await tokenWith(ALL);
      const created = store.addLead();

      const client = await put(`/api/v1/leads/${created.id}`, token, {
        type: LeadType.CLIENT,
      }).expect(200);
      expect(dataOf<LeadBody>(client).becameClientAt).not.toBeNull();

      const back = await put(`/api/v1/leads/${created.id}`, token, {
        type: LeadType.LEAD,
      }).expect(200);
      expect(dataOf<LeadBody>(back).becameClientAt).toBeNull();
    });

    it('обычная правка карточки дату перехода не переписывает', async () => {
      const token = await tokenWith(ALL);
      const becameClientAt = new Date('2026-08-20T12:00:00.000Z');
      const created = store.addLead({ type: LeadType.CLIENT, becameClientAt });

      const response = await put(`/api/v1/leads/${created.id}`, token, {
        notes: 'перезвонить',
      }).expect(200);

      expect(dataOf<LeadBody>(response).becameClientAt).toBe(becameClientAt.toISOString());
    });

    it('пустая строка снимает курс, купон и филиал', async () => {
      const token = await tokenWith(ALL);
      const course = store.addCourse();
      const created = store.addLead({ course: { id: course.id, title: course.title } });

      const response = await put(`/api/v1/leads/${created.id}`, token, { courseId: '' }).expect(
        200,
      );

      expect(dataOf<LeadBody>(response).course).toBeNull();
    });

    it('телефон пустой строкой не очищается (400), номер остаётся прежним', async () => {
      const token = await tokenWith(ALL);
      const created = store.addLead();

      await put(`/api/v1/leads/${created.id}`, token, { phone: '' }).expect(400);

      expect(store.leads.get(created.id)?.phone).toBe('+992901234567');
    });

    it('список свежими сверху, с фильтрами по стадии, курсу и месяцу записи', async () => {
      const token = await tokenWith(ALL);
      const course = store.addCourse('Frontend');
      store.addLead({ lastName: 'Азизов', type: LeadType.CLIENT });
      store.addLead({
        lastName: 'Каримова',
        course: { id: course.id, title: course.title },
        enrollMonth: day('2026-09-01'),
      });

      const all = await get('/api/v1/leads', token).expect(200);
      expect(dataOf<LeadBody[]>(all).map((row) => row.lastName)).toEqual(['Каримова', 'Азизов']);
      expect(metaOf(all)).toMatchObject({ total: 2, page: 1, limit: 20 });

      const clients = await get(`/api/v1/leads?type=${LeadType.CLIENT}`, token).expect(200);
      expect(dataOf<LeadBody[]>(clients).map((row) => row.lastName)).toEqual(['Азизов']);

      const byCourse = await get(`/api/v1/leads?courseId=${course.id}`, token).expect(200);
      expect(dataOf<LeadBody[]>(byCourse).map((row) => row.lastName)).toEqual(['Каримова']);

      const byMonth = await get('/api/v1/leads?enrollMonth=2026-09', token).expect(200);
      expect(dataOf<LeadBody[]>(byMonth).map((row) => row.lastName)).toEqual(['Каримова']);
    });

    it('поиск идёт и по источнику, и по UTM-кампании, и по фамилии', async () => {
      const token = await tokenWith(ALL);
      store.addLead({ lastName: 'Азизов', source: 'рекомендация подруги' });
      store.addLead({ lastName: 'Каримова', utmCampaign: 'osen-2026' });

      const bySource = await get('/api/v1/leads?search=рекомендация', token).expect(200);
      expect(dataOf<LeadBody[]>(bySource).map((row) => row.lastName)).toEqual(['Азизов']);

      const byCampaign = await get('/api/v1/leads?search=osen', token).expect(200);
      expect(dataOf<LeadBody[]>(byCampaign).map((row) => row.lastName)).toEqual(['Каримова']);

      const byName = await get('/api/v1/leads?search=Карим', token).expect(200);
      expect(dataOf<LeadBody[]>(byName).map((row) => row.lastName)).toEqual(['Каримова']);
    });

    it('фильтр `converted` разделяет воронку и переведённых', async () => {
      const token = await tokenWith(ALL);
      store.addLead({ lastName: 'Азизов' });
      store.addLead({ lastName: 'Каримова', convertedStudentId: randomUUID() });

      const inFunnel = await get('/api/v1/leads?converted=false', token).expect(200);
      expect(dataOf<LeadBody[]>(inFunnel).map((row) => row.lastName)).toEqual(['Азизов']);

      const done = await get('/api/v1/leads?converted=true', token).expect(200);
      expect(dataOf<LeadBody[]>(done).map((row) => row.lastName)).toEqual(['Каримова']);
    });

    it('400 на неизвестное поле сортировки, не-UUID в фильтре и в пути', async () => {
      const token = await tokenWith(ALL);

      await get('/api/v1/leads?sort=phone', token).expect(400);
      await get('/api/v1/leads?courseId=not-a-uuid', token).expect(400);
      await get('/api/v1/leads/not-a-uuid', token).expect(400);
    });

    it('404 на неизвестного лида при чтении, правке и удалении', async () => {
      const token = await tokenWith(ALL);
      const ghost = randomUUID();

      await get(`/api/v1/leads/${ghost}`, token).expect(404);
      await put(`/api/v1/leads/${ghost}`, token, { notes: 'x' }).expect(404);
      await del(`/api/v1/leads/${ghost}`, token).expect(404);
    });

    it('удаляет лида без ограничений — включая переведённого в студенты', async () => {
      const token = await tokenWith(ALL);
      const converted = store.addLead({ convertedStudentId: randomUUID() });

      await del(`/api/v1/leads/${converted.id}`, token).expect(200);

      expect(store.leads.size).toBe(0);
    });
  });

  // ──────────────────────── Связь лидов и купонов ────────────────────────

  describe('Купон и лиды вместе', () => {
    it('обещанный лиду купон не удаляется (409) и остаётся на месте', async () => {
      const token = await tokenWith(ALL);
      const coupon = store.addCoupon({ name: 'OSEN' });
      store.addLead({ coupon: { id: coupon.id, name: coupon.name } });

      const response = await del(`/api/v1/coupons/${coupon.id}`, token).expect(409);

      expect((response.body as { error: { message: string } }).error.message).toContain('(1)');
      expect(store.coupons.size).toBe(1);
    });

    it('удалили лида — купон освободился и удаляется', async () => {
      const token = await tokenWith(ALL);
      const coupon = store.addCoupon({ name: 'OSEN' });
      const created = store.addLead({ coupon: { id: coupon.id, name: coupon.name } });

      await del(`/api/v1/coupons/${coupon.id}`, token).expect(409);
      await del(`/api/v1/leads/${created.id}`, token).expect(200);
      await del(`/api/v1/coupons/${coupon.id}`, token).expect(200);

      expect(store.coupons.size).toBe(0);
    });

    it('число обещанных лидов видно в карточке купона', async () => {
      const token = await tokenWith(ALL);
      const coupon = store.addCoupon({ name: 'OSEN' });
      store.addLead({ coupon: { id: coupon.id, name: coupon.name } });
      store.addLead({ coupon: { id: coupon.id, name: coupon.name } });

      const response = await get(`/api/v1/coupons/${coupon.id}`, token).expect(200);

      expect(dataOf<CouponBody>(response).leadsCount).toBe(2);
    });
  });

  // ─────────────────── Перевод в студенты (ТЗ 5.7) ───────────────────

  describe('Перевод лидов в студенты', () => {
    it('заводит профиль студента из полей обращения и не удаляет само обращение', async () => {
      const token = await tokenWith(ALL);
      const branch = store.addBranch('Sadbarg');
      const created = store.addLead({
        firstName: 'Нигина',
        lastName: 'Каримова',
        phone: '+992901234567',
        email: 'nigina@mail.tj',
        birthDate: day('2004-05-17'),
        gender: Gender.FEMALE,
        branch: { id: branch.id, name: branch.name },
      });

      const response = await post('/api/v1/leads/transfer', token, {
        leadIds: [created.id],
      }).expect(200);

      const body = dataOf<TransferBody>(response);
      expect(body).toMatchObject({ created: 1, linked: 0 });
      expect(body.transferred[0]).toMatchObject({
        leadId: created.id,
        name: 'Каримова Нигина',
        action: 'created',
      });

      // Профиль заведён со всеми полями человека.
      expect(store.students.get(body.transferred[0].studentId)).toMatchObject({
        firstName: 'Нигина',
        lastName: 'Каримова',
        phone: '+992901234567',
        email: 'nigina@mail.tj',
        birthDate: day('2004-05-17'),
        gender: Gender.FEMALE,
        branchId: branch.id,
      });

      // Обращение осталось в воронке и хранит ссылку на профиль (ТЗ 5.2).
      const card = await get(`/api/v1/leads/${created.id}`, token).expect(200);
      expect(dataOf<LeadBody>(card).conversion).toMatchObject({
        converted: true,
        studentId: body.transferred[0].studentId,
      });
    });

    it('телефон, занятый студентом, привязывает к нему — второй профиль не заводится', async () => {
      // Главное решение куска: обращение всё-таки стало студентом, и отказ
      // вычеркнул бы его из воронки.
      const token = await tokenWith(ALL);
      const student = store.addStudent({ phone: '+992901234567', lastName: 'Каримова' });
      const created = store.addLead({ phone: '+992901234567' });

      const response = await post('/api/v1/leads/transfer', token, {
        leadIds: [created.id],
      }).expect(200);

      expect(dataOf<TransferBody>(response)).toMatchObject({
        transferred: [{ leadId: created.id, studentId: student.id, action: 'linked' }],
        created: 0,
        linked: 1,
      });
      expect(store.students.size).toBe(1);
    });

    it('переводит пачку и считает заведённые отдельно от привязанных', async () => {
      const token = await tokenWith(ALL);
      store.addStudent({ phone: '+992901111111' });
      const first = store.addLead({ phone: '+992901111111' });
      const second = store.addLead({ phone: '+992902222222' });
      const third = store.addLead({ phone: '+992903333333' });

      const response = await post('/api/v1/leads/transfer', token, {
        leadIds: [first.id, second.id, third.id],
      }).expect(200);

      expect(dataOf<TransferBody>(response)).toMatchObject({ created: 2, linked: 1 });
      expect(store.students.size).toBe(3);
    });

    it('«по строке» — тот же маршрут со списком из одного элемента', async () => {
      const token = await tokenWith(ALL);
      const created = store.addLead();

      const response = await post('/api/v1/leads/transfer', token, {
        leadIds: [created.id],
      }).expect(200);

      expect(dataOf<TransferBody>(response).transferred).toHaveLength(1);
    });

    it('422 на повторный перевод — профиль второй раз не заводится', async () => {
      const token = await tokenWith(ALL);
      const created = store.addLead();

      await post('/api/v1/leads/transfer', token, { leadIds: [created.id] }).expect(200);
      const second = await post('/api/v1/leads/transfer', token, {
        leadIds: [created.id],
      }).expect(422);

      expect(second.body).toMatchObject({
        error: {
          details: {
            total: 1,
            rejected: [{ leadId: created.id, reason: expect.stringContaining('уже переведено') }],
          },
        },
      });
      expect(store.students.size).toBe(1);
    });

    it('422 на профиль, заведённый из другого обращения', async () => {
      const token = await tokenWith(ALL);
      const first = store.addLead({ phone: '+992901234567' });
      const second = store.addLead({ phone: '+992901234567' });

      await post('/api/v1/leads/transfer', token, { leadIds: [first.id] }).expect(200);

      const response = await post('/api/v1/leads/transfer', token, {
        leadIds: [second.id],
      }).expect(422);

      expect(response.body).toMatchObject({
        error: {
          details: {
            rejected: [
              { leadId: second.id, reason: expect.stringContaining('из другого обращения') },
            ],
          },
        },
      });
      expect(store.students.size).toBe(1);
    });

    it('422 на два обращения с одним телефоном в одной пачке — не переведён никто', async () => {
      const token = await tokenWith(ALL);
      const first = store.addLead({ phone: '+992901234567' });
      const second = store.addLead({ phone: '+992901234567' });

      const response = await post('/api/v1/leads/transfer', token, {
        leadIds: [first.id, second.id],
      }).expect(422);

      expect(response.body).toMatchObject({
        error: {
          details: {
            rejected: [{ leadId: second.id, reason: expect.stringContaining('в этой же пачке') }],
          },
        },
      });
      // Отказ целиком: первое обращение тоже не переведено.
      expect(store.students.size).toBe(0);
      expect(store.leads.get(first.id)?.convertedStudentId).toBeNull();
    });

    it('422 на несуществующее обращение — годная строка пачки тоже не применяется', async () => {
      const token = await tokenWith(ALL);
      const created = store.addLead();
      const missing = randomUUID();

      const response = await post('/api/v1/leads/transfer', token, {
        leadIds: [created.id, missing],
      }).expect(422);

      expect(response.body).toMatchObject({
        error: {
          details: {
            rejected: [{ leadId: missing, reason: expect.stringContaining('не найдено') }],
          },
        },
      });
      expect(store.students.size).toBe(0);
      expect(store.leads.get(created.id)?.convertedStudentId).toBeNull();
    });

    it('фильтр `converted` разделяет переведённых и оставшихся в воронке', async () => {
      const token = await tokenWith(ALL);
      const transferred = store.addLead({ phone: '+992901111111', lastName: 'Каримова' });
      store.addLead({ phone: '+992902222222', lastName: 'Рахимова' });

      await post('/api/v1/leads/transfer', token, { leadIds: [transferred.id] }).expect(200);

      const done = await get('/api/v1/leads?converted=true', token).expect(200);
      const open = await get('/api/v1/leads?converted=false', token).expect(200);

      expect(dataOf<LeadBody[]>(done).map((row) => row.lastName)).toEqual(['Каримова']);
      expect(dataOf<LeadBody[]>(open).map((row) => row.lastName)).toEqual(['Рахимова']);
    });

    it('переведённое обращение удаляется — это способ освободить ошибочный профиль', async () => {
      const token = await tokenWith(ALL);
      const created = store.addLead();

      await post('/api/v1/leads/transfer', token, { leadIds: [created.id] }).expect(200);
      await del(`/api/v1/leads/${created.id}`, token).expect(200);

      expect(store.leads.size).toBe(0);
      // Профиль остаётся: удаляется обращение, а не студент.
      expect(store.students.size).toBe(1);
    });

    it('400 на пустой список, повтор в нём, не-UUID и лишнее поле', async () => {
      const token = await tokenWith(ALL);
      const created = store.addLead();

      await post('/api/v1/leads/transfer', token, { leadIds: [] }).expect(400);
      await post('/api/v1/leads/transfer', token, {
        leadIds: [created.id, created.id],
      }).expect(400);
      await post('/api/v1/leads/transfer', token, { leadIds: ['не-uuid'] }).expect(400);
      await post('/api/v1/leads/transfer', token, {
        leadIds: [created.id],
        groupId: randomUUID(),
      }).expect(400);

      expect(store.students.size).toBe(0);
    });

    it('403: право на правку лида перевод не открывает, и наоборот', async () => {
      const created = store.addLead();

      await post('/api/v1/leads/transfer', await tokenWith([LEADS_UPDATE]), {
        leadIds: [created.id],
      }).expect(403);
      await put(`/api/v1/leads/${created.id}`, await tokenWith([LEADS_TRANSFER]), {
        firstName: 'Нигина',
      }).expect(403);
    });
  });

  // ────────────────────── Выгрузка лидов (ТЗ 5.7) ──────────────────────

  describe('Выгрузка лидов в CSV', () => {
    it('отдаёт файл с BOM и заголовками вместо `{ data }`', async () => {
      const token = await tokenWith(ALL);
      const course = store.addCourse('Frontend');
      store.addLead({
        lastName: 'Каримова',
        firstName: 'Нигина',
        phone: '+992901234567',
        course: { id: course.id, title: course.title },
        type: LeadType.CLIENT,
      });

      const response = await get('/api/v1/leads/export', token).expect(200);

      expect(response.headers['content-type']).toContain('text/csv');
      expect(response.headers['content-disposition']).toContain('attachment');
      expect(response.headers['content-disposition']).toContain('filename*=UTF-8');
      expect(response.text.startsWith('﻿')).toBe(true);

      const [header, first] = response.text.replace('﻿', '').trimEnd().split('\r\n');
      expect(header.split(',')[0]).toBe('Телефон');
      expect(first).toContain('+992901234567');
      expect(first).toContain('Каримова');
      // Перечисления — словами, а не кодами enum.
      expect(first).toContain('Клиент');
      expect(first).toContain('Frontend');
    });

    it('выгружает весь отобранный набор, а не страницу', async () => {
      const token = await tokenWith(ALL);
      for (let index = 0; index < 25; index += 1) {
        store.addLead({ phone: `+99290000${String(index).padStart(4, '0')}` });
      }

      const response = await get('/api/v1/leads/export', token).expect(200);

      // 25 строк данных плюс заголовок — страница по умолчанию вместила бы 20.
      expect(response.text.replace('﻿', '').trimEnd().split('\r\n')).toHaveLength(26);
    });

    it('фильтры те же, что у списка: выгрузка и экран показывают один набор', async () => {
      const token = await tokenWith(ALL);
      store.addLead({ lastName: 'Каримова', type: LeadType.CLIENT });
      store.addLead({ lastName: 'Рахимова', type: LeadType.LEAD });

      const file = await get('/api/v1/leads/export?type=CLIENT', token).expect(200);
      const list = await get('/api/v1/leads?type=CLIENT', token).expect(200);

      expect(file.text).toContain('Каримова');
      expect(file.text).not.toContain('Рахимова');
      expect(dataOf<LeadBody[]>(list)).toHaveLength(1);
    });

    it('поиск по UTM-кампании отбирает строки и в файле', async () => {
      const token = await tokenWith(ALL);
      store.addLead({ lastName: 'Каримова', utmCampaign: 'osen-2026' });
      store.addLead({ lastName: 'Рахимова', utmCampaign: 'zima-2027' });

      const response = await get('/api/v1/leads/export?search=osen', token).expect(200);

      expect(response.text).toContain('Каримова');
      expect(response.text).not.toContain('Рахимова');
    });

    it('пустая выборка отдаёт файл из одного заголовка, а не 404', async () => {
      const token = await tokenWith(ALL);

      const response = await get('/api/v1/leads/export?type=CLIENT', token).expect(200);

      expect(response.text.replace('﻿', '').trimEnd().split('\r\n')).toHaveLength(1);
    });

    it('400 на негодный месяц в фильтре выгрузки', async () => {
      const token = await tokenWith(ALL);

      await get('/api/v1/leads/export?from=2026-13', token).expect(400);
    });

    it('403: право на просмотр выгрузку не открывает — это вынос персональных данных', async () => {
      await get('/api/v1/leads/export', await tokenWith([LEADS_VIEWS])).expect(403);
      await get('/api/v1/leads/export', await tokenWith([LEADS_EXPORT])).expect(200);
    });

    it('`export` не путается с карточкой лида', async () => {
      // Маршрут объявлен до `:id`; иначе `ParseUUIDPipe` ответил бы 400.
      const token = await tokenWith(ALL);

      await get('/api/v1/leads/export', token).expect(200);
      await get(`/api/v1/leads/${randomUUID()}`, token).expect(404);
    });
  });

  // ───────────────────────────── OpenAPI ─────────────────────────────

  describe('OpenAPI', () => {
    it('описывает маршруты лидов и купонов', () => {
      const paths = buildOpenApiDocument(app).paths;

      expect(Object.keys(paths)).toEqual(
        expect.arrayContaining([
          '/api/v1/leads',
          '/api/v1/leads/{id}',
          '/api/v1/leads/transfer',
          '/api/v1/leads/export',
          '/api/v1/coupons',
          '/api/v1/coupons/{id}',
        ]),
      );
    });

    it('создание отвечает 201 и не 200 — у обоих справочников', () => {
      const paths = buildOpenApiDocument(app).paths;

      expect(paths['/api/v1/leads']?.post?.responses['201']).toBeDefined();
      expect(paths['/api/v1/leads']?.post?.responses['200']).toBeUndefined();
      expect(paths['/api/v1/coupons']?.post?.responses['201']).toBeDefined();
      expect(paths['/api/v1/coupons']?.post?.responses['200']).toBeUndefined();
    });

    it('перевод отвечает 200 и не 201: по этому адресу ресурс не создаётся', () => {
      // Заведённые профили лежат по `/students/{id}`, а здесь возвращается
      // результат применения — та же причина, что у импорта состава (0013).
      const paths = buildOpenApiDocument(app).paths;

      expect(paths['/api/v1/leads/transfer']?.post?.responses['200']).toBeDefined();
      expect(paths['/api/v1/leads/transfer']?.post?.responses['201']).toBeUndefined();
    });

    it('выгрузка описана как `text/csv`, а не как `{ data }`', () => {
      const paths = buildOpenApiDocument(app).paths;

      expect(paths['/api/v1/leads/export']?.get?.responses['200']).toMatchObject({
        content: { 'text/csv': expect.anything() },
      });
    });
  });
});
