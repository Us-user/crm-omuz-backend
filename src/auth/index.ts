// `auth.module` намеренно не реэкспортируется: barrel затягивают DTO и guard'ы
// других модулей, а модуль тянет за собой Passport и JWT.
export * from './auth.constants';
export * from './auth.types';
export * from './decorators/account-type.decorator';
export * from './decorators/current-user.decorator';
export * from './decorators/public.decorator';
export * from './dto';
export * from './guards/account-type.guard';
export * from './guards/jwt-auth.guard';
export * from './password.service';
