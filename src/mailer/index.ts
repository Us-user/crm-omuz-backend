// `mailer.module` не реэкспортируется: модуль подключается по прямому пути,
// чтобы barrel не тянул реализацию провайдера в потребителей контракта.
export * from './mailer.service';
export * from './mailer.types';
