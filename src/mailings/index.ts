// `mailings.module` и `mailings-worker.module` не реэкспортируются: barrel
// затянул бы в потребителей контроллеры и обработчик очереди (приём 0003).
export * from './mailing-delivery.service';
export * from './mailing-dispatcher';
export * from './mailings';
