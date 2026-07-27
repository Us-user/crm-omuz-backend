import type { Prisma } from '@prisma/client';
import { GroupStudentStatus } from '@prisma/client';

/**
 * Общий балл студента и категории активности (ТЗ 5.8, 5.5).
 *
 * Правило вынесено чистыми функциями и живёт отдельно от модулей, которые его
 * применяют: общий балл нужен витрине успеваемости (ТЗ 5.3), карточке студента
 * (корона), карточке группы (счётчики категорий) и рейтингу центра (ТЗ 5.13).
 * Вторая копия порогов рядом с каждым из них разошлась бы с первой на первой же
 * правке — тот же ход, что с `deriveStudentStatus` (сессия 0014)
 * и `coinsForWeekSum` (сессия 0018).
 */

/**
 * Категории активности (ТЗ 5.5). В БД не хранятся: категория выводится
 * из общего балла, а он — агрегат по `WeekResult` (решение сессии 0019).
 * Отдельная колонка была бы вторым источником истины о том же числе
 * и требовала бы пересчёта в каждом месте, где правится журнал.
 */
export enum ActivityCategory {
  ChatGpt = 'CHAT_GPT',
  Handsome = 'HANDSOME',
  Advanced = 'ADVANCED',
  Kettle = 'KETTLE',
  BlackList = 'BLACK_LIST',
}

export interface ActivityCategoryThreshold {
  /** Нижняя граница общего балла, включительно. */
  minScore: number;
  category: ActivityCategory;
}

/**
 * Пороги ТЗ 5.5 дословно: `ChatGPT ≥95 · Handsome 80–94 · Advanced 65–79 ·
 * Kettle 45–64 · Black list <45`. Перечислены по убыванию — первый подошедший
 * и есть ответ; всё, что ниже последнего порога, попадает в `BLACK_LIST`.
 */
export const ACTIVITY_CATEGORY_THRESHOLDS: readonly ActivityCategoryThreshold[] = [
  { minScore: 95, category: ActivityCategory.ChatGpt },
  { minScore: 80, category: ActivityCategory.Handsome },
  { minScore: 65, category: ActivityCategory.Advanced },
  { minScore: 45, category: ActivityCategory.Kettle },
];

/** Название категории для экрана — так, как их пишет ТЗ 5.5. */
export const ACTIVITY_CATEGORY_TITLES: Readonly<Record<ActivityCategory, string>> = {
  [ActivityCategory.ChatGpt]: 'ChatGPT',
  [ActivityCategory.Handsome]: 'Handsome',
  [ActivityCategory.Advanced]: 'Advanced',
  [ActivityCategory.Kettle]: 'Kettle',
  [ActivityCategory.BlackList]: 'Black list',
};

/**
 * Проходной балл для «Passing students» (ТЗ 5.5: «успевающих из всех»).
 *
 * ТЗ отдельного порога не задаёт, поэтому он **выводится** из таблицы категорий,
 * а не объявляется рядом с ней вторым числом: успевающий — это всякий, кто
 * не попал в нижнюю категорию, которую ТЗ прямо называет «Black list».
 * При правке порогов согласовывать два места не придётся.
 */
export const PASSING_MIN_SCORE = Math.min(
  ...ACTIVITY_CATEGORY_THRESHOLDS.map(({ minScore }) => minScore),
);

/** Знаков после запятой в общем балле: он среднее, и целым бывает редко. */
export const SCORE_PRECISION = 2;

/**
 * Округление для показа. Внутри сравнения (место в рейтинге, корона) идут
 * по **неокруглённому** значению: два студента с 87.334 и 87.335 показали бы
 * одинаковые 87.33, и округление до сравнения сделало бы их обоих первыми.
 */
export const roundScore = (value: number): number => Number(value.toFixed(SCORE_PRECISION));

/**
 * Общий балл = среднее `Sum` по неделям (ТЗ 5.8).
 *
 * `null`, а не ноль, когда учитывать нечего: у студента, которому ещё ни одной
 * недели не закрыли, балла **нет** — и ноль записал бы его в `Black list`
 * за то, что его группа просто не дошла до первой финализации.
 */
export function averageScore(sums: readonly number[]): number | null {
  if (sums.length === 0) return null;

  return sums.reduce((total, sum) => total + sum, 0) / sums.length;
}

/** Категория по общему баллу (ТЗ 5.5). `null` — балла нет, категории тоже. */
export function activityCategoryOf(score: number | null): ActivityCategory | null {
  if (score === null) return null;

  return (
    ACTIVITY_CATEGORY_THRESHOLDS.find(({ minScore }) => score >= minScore)?.category ??
    ActivityCategory.BlackList
  );
}

/**
 * Успевающий ли студент (ТЗ 5.5: «Passing students»). Студент без балла
 * не успевающий и не отстающий — он просто не оценён, поэтому `false`:
 * счётчик успевающих не должен расти за счёт тех, кого не оценивали.
 */
export const isPassing = (score: number | null): boolean =>
  score !== null && score >= PASSING_MIN_SCORE;

/**
 * Недели, которые входят в общий балл: **только финализированные**
 * (решение сессии 0019, вынесено пользователю).
 *
 * Открытая неделя заводится с нулевыми итогами на весь действующий состав
 * (`createWeek`, сессия 0018), поэтому при учёте всех недель средний балл
 * каждого студента обрушивался бы в понедельник и восстанавливался к пятнице,
 * а вместе с ним прыгали бы категория активности и корона. Коины по ТЗ 5.9
 * начисляются тоже при финализации — балл и коины опираются на одни и те же
 * закрытые недели.
 *
 * Фильтр — общая константа, а не условие, переписанное в каждом репозитории:
 * три места, считающие балл по разным наборам недель, разошлись бы молча.
 */
export const FINALIZED_WEEK_FILTER = {
  submittedAt: { not: null },
} satisfies Prisma.JournalWeekWhereInput;

/**
 * Кого охватывают рейтинг и корона (решение сессии 0019, вынесено пользователю):
 * студентов, которые учатся **сейчас** — то есть имеют действующее членство.
 *
 * Иначе корона навсегда осталась бы у выпускника прошлого года, и «топ-студент»
 * перестал бы быть достижимой целью для тех, кто учится. Свой балл и своя
 * категория при этом остаются видны у каждого — из рейтинга выпадает только
 * место в списке.
 */
export const RANKED_STUDENT_FILTER = {
  groups: { some: { status: GroupStudentStatus.ACTIVE } },
} satisfies Prisma.StudentWhereInput;

/** Сколько студентов в каждой категории — счётчики карточки группы (ТЗ 5.5). */
export type ActivityCategoryCounts = Record<ActivityCategory, number> & {
  /** Те, у кого ещё нет ни одной финализированной недели, — категории у них нет. */
  unscored: number;
};

const emptyCounts = (): ActivityCategoryCounts => ({
  [ActivityCategory.ChatGpt]: 0,
  [ActivityCategory.Handsome]: 0,
  [ActivityCategory.Advanced]: 0,
  [ActivityCategory.Kettle]: 0,
  [ActivityCategory.BlackList]: 0,
  unscored: 0,
});

/**
 * Раскладка списка баллов по категориям (ТЗ 5.5: «счётчики категорий
 * активности» в списке групп). Балл `null` идёт в `unscored`, а не в нижнюю
 * категорию: «не оценён» и «в чёрном списке» — разные вещи.
 */
export function countByCategory(scores: readonly (number | null)[]): ActivityCategoryCounts {
  const counts = emptyCounts();

  for (const score of scores) {
    const category = activityCategoryOf(score);
    if (category === null) {
      counts.unscored += 1;
    } else {
      counts[category] += 1;
    }
  }

  return counts;
}
