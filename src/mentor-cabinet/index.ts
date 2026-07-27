// `mentor-cabinet.module` намеренно не реэкспортируется — как и в остальных
// модулях: barrel затягивают DTO и типы соседей, а модуль тянет контроллер
// и репозиторий.
export * from './dto';
export * from './mentor-cabinet.repository';
export * from './mentor-cabinet.service';
