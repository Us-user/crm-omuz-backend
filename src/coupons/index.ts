// `coupons.module` намеренно не реэкспортируется — как в остальных модулях:
// barrel затягивают DTO и типы, а модуль тянет контроллер и репозиторий.
export * from './coupons';
export * from './coupons.repository';
export * from './coupons.service';
export * from './dto';
