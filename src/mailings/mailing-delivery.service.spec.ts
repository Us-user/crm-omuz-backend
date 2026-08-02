import { MessageChannel, NotificationStatus } from '@prisma/client';

import type { MessageSender } from '../messaging';
import { PermanentDeliveryError } from '../messaging';
import { DeliveryOutcome, MailingDeliveryService } from './mailing-delivery.service';
import type { DeliveryRow, MailingsRepository } from './mailings.repository';

const delivery = (over: Partial<DeliveryRow> = {}): DeliveryRow => ({
  id: 'n1',
  channel: MessageChannel.TELEGRAM,
  address: '@umed',
  status: NotificationStatus.PENDING,
  attempts: 0,
  mailing: { id: 'm1', title: 'Занятия', body: 'Перенос на 14:00' },
  ...over,
});

interface Repo {
  findDelivery: jest.Mock;
  markDelivered: jest.Mock;
  markDeliveryFailed: jest.Mock;
  registerAttempt: jest.Mock;
}

const build = (
  row: DeliveryRow | null,
  send: jest.Mock,
): { service: MailingDeliveryService; repo: Repo } => {
  const repo: Repo = {
    findDelivery: jest.fn().mockResolvedValue(row),
    markDelivered: jest.fn().mockResolvedValue(undefined),
    markDeliveryFailed: jest.fn().mockResolvedValue(undefined),
    registerAttempt: jest.fn().mockResolvedValue(undefined),
  };

  const sender = { send } as unknown as MessageSender;

  return {
    service: new MailingDeliveryService(repo as unknown as MailingsRepository, sender),
    repo,
  };
};

describe('MailingDeliveryService', () => {
  it('отправляет сообщение и помечает доставку выполненной', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    const { service, repo } = build(delivery(), send);

    await expect(service.deliver('n1', false)).resolves.toBe(DeliveryOutcome.Sent);

    expect(send).toHaveBeenCalledWith({
      channel: MessageChannel.TELEGRAM,
      address: '@umed',
      title: 'Занятия',
      body: 'Перенос на 14:00',
    });
    expect(repo.markDelivered).toHaveBeenCalledWith('n1', 1, expect.any(Date));
  });

  it('текст берётся из рассылки, а канал и адрес — из строки доставки', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    const { service } = build(
      delivery({ channel: MessageChannel.SMS, address: '+992900000001' }),
      send,
    );

    await service.deliver('n1', false);

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ channel: MessageChannel.SMS, address: '+992900000001' }),
    );
  });

  it('несуществующую доставку пропускает, а не падает', async () => {
    const send = jest.fn();
    const { service } = build(null, send);

    await expect(service.deliver('n1', true)).resolves.toBe(DeliveryOutcome.Skipped);
    expect(send).not.toHaveBeenCalled();
  });

  it('уже доставленную второй раз не шлёт: задача могла прийти повторно', async () => {
    const send = jest.fn();
    const { service, repo } = build(delivery({ status: NotificationStatus.SENT }), send);

    await expect(service.deliver('n1', false)).resolves.toBe(DeliveryOutcome.Skipped);
    expect(send).not.toHaveBeenCalled();
    expect(repo.markDelivered).not.toHaveBeenCalled();
  });

  it('пропущенную из-за отсутствия адреса не трогает', async () => {
    const send = jest.fn();
    const { service } = build(delivery({ status: NotificationStatus.SKIPPED }), send);

    await expect(service.deliver('n1', true)).resolves.toBe(DeliveryOutcome.Skipped);
    expect(send).not.toHaveBeenCalled();
  });

  it('временный отказ до последней попытки учитывает и просит повтор', async () => {
    const send = jest.fn().mockRejectedValue(new Error('провайдер недоступен'));
    const { service, repo } = build(delivery({ attempts: 1 }), send);

    await expect(service.deliver('n1', false)).resolves.toBe(DeliveryOutcome.Retry);

    expect(repo.registerAttempt).toHaveBeenCalledWith('n1', 2, 'провайдер недоступен');
    expect(repo.markDeliveryFailed).not.toHaveBeenCalled();
  });

  it('на последней попытке отказ записывается в строку доставки', async () => {
    const send = jest.fn().mockRejectedValue(new Error('провайдер недоступен'));
    const { service, repo } = build(delivery({ attempts: 2 }), send);

    await expect(service.deliver('n1', true)).resolves.toBe(DeliveryOutcome.Failed);

    expect(repo.markDeliveryFailed).toHaveBeenCalledWith('n1', 3, 'провайдер недоступен');
    expect(repo.registerAttempt).not.toHaveBeenCalled();
  });

  it('окончательный отказ провайдера не ждёт последней попытки', async () => {
    // Три попытки подряд вернули бы тот же ответ, а получатель всё это время
    // числился бы «в очереди».
    const send = jest.fn().mockRejectedValue(new PermanentDeliveryError('неизвестный адрес'));
    const { service, repo } = build(delivery(), send);

    await expect(service.deliver('n1', false)).resolves.toBe(DeliveryOutcome.Failed);

    expect(repo.markDeliveryFailed).toHaveBeenCalledWith('n1', 1, 'неизвестный адрес');
  });

  it('нестроковую причину отказа приводит к тексту, а не роняет обработчик', async () => {
    const send = jest.fn().mockRejectedValue('таймаут');
    const { service, repo } = build(delivery(), send);

    await expect(service.deliver('n1', true)).resolves.toBe(DeliveryOutcome.Failed);
    expect(repo.markDeliveryFailed).toHaveBeenCalledWith('n1', 1, 'таймаут');
  });

  it('счётчик попыток растёт от того, что уже записано в строке', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    const { service, repo } = build(delivery({ attempts: 4 }), send);

    await service.deliver('n1', false);

    expect(repo.markDelivered).toHaveBeenCalledWith('n1', 5, expect.any(Date));
  });
});
