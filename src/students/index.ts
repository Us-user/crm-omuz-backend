// `students.module` намеренно не реэкспортируется — как и в Auth: barrel
// затягивают DTO и типы других модулей, а модуль тянет контроллер и репозиторий.
export * from './dto';
export * from './student-promotion.service';
export * from './students.repository';
