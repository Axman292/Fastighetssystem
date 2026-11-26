import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';

/** Översätter databasfel till begripliga svar på svenska. */
@Catch()
export class DbErrorsFilter implements ExceptionFilter {
  private readonly log = new Logger('Fel');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      res.status(exception.getStatus()).json(typeof body === 'string' ? { message: body } : body);
      return;
    }
    const err = (exception as { cause?: unknown })?.cause ?? exception;
    const code = (err as { code?: string })?.code;
    if (code === '23505') {
      res.status(409).json({ message: 'Uppgiften finns redan', detail: (err as { detail?: string }).detail });
      return;
    }
    if (code === '42501') {
      res.status(403).json({ message: 'Databasen nekade åtkomst till bolaget' });
      return;
    }
    if (code === '23514') {
      const msg = (err as { message?: string }).message ?? '';
      res.status(400).json({ message: msg.includes('violates check constraint') ? 'Ogiltiga uppgifter' : msg });
      return;
    }
    if (code === '22P02') {
      res.status(400).json({ message: 'Ogiltiga uppgifter' });
      return;
    }
    if (code === '23503') {
      res.status(400).json({ message: 'Uppgiften hänvisar till något som inte finns i valt bolag' });
      return;
    }
    if (code === '23P01') {
      const table = (err as { table?: string }).table;
      res.status(409).json({
        message:
          table === 'contract_object'
            ? 'Objektet ingår redan i ett annat avtal under perioden'
            : 'Perioden överlappar en befintlig period',
      });
      return;
    }
    this.log.error(exception);
    res.status(500).json({ message: 'Något gick fel' });
  }
}
