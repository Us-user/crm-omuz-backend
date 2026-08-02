// `messaging.module` не реэкспортируется: модуль подключается по прямому пути,
// чтобы barrel не тянул реализацию провайдера в потребителей контракта (0003).
export * from './message-sender.service';
export * from './messaging.types';
