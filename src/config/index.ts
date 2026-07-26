// Внимание: `config.module` здесь намеренно НЕ реэкспортируется.
// `ConfigModule.forRoot()` вычисляется в момент импорта модуля и сразу валидирует
// окружение — иначе любой юнит-тест, случайно затянувший этот barrel, требовал бы
// полноценного `.env`. Сам модуль импортируется из `./config/config.module`.
export * from './app-config.service';
export * from './env.validation';
