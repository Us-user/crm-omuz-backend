// `avans.module` намеренно не реэкспортируется — как и в остальных модулях:
// barrel затягивают DTO и типы соседей, а модуль тянет контроллер и репозиторий.
export * from './avans-review.service';
export * from './avans.repository';
export * from './avans.service';
export * from './dto';
