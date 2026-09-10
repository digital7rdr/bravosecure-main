import 'reflect-metadata';
import {plainToInstance} from 'class-transformer';
import {validate} from 'class-validator';
import {CreateBookingDto, EstimateBookingDto} from './dto/create-booking.dto';

// #4 — "Driver Only (Client Vehicle)" sends vehicle_count=0. class-validator's
// @IsOptional() does NOT skip a present 0, so the old @Min(1) rejected it with
// "vehicle_count must not be less than 1". After the @Min(0) fix, 0 is valid and
// the @Max(4) upper bound + negative guard still hold.
async function vehicleCountErrors(
  Cls: new () => object,
  vehicle_count: number,
): Promise<string[]> {
  const dto = plainToInstance(Cls, {vehicle_count});
  const errs = await validate(dto);
  const vc = errs.find(e => e.property === 'vehicle_count');
  return vc ? Object.values(vc.constraints ?? {}) : [];
}

describe('vehicle_count validation (#4 Driver-only Client Vehicle)', () => {
  for (const Cls of [CreateBookingDto, EstimateBookingDto] as const) {
    describe(Cls.name, () => {
      it('accepts 0 (driver-only — client supplies the vehicle)', async () => {
        expect(await vehicleCountErrors(Cls, 0)).toEqual([]);
      });

      it('still rejects a negative vehicle_count', async () => {
        expect(await vehicleCountErrors(Cls, -1)).not.toEqual([]);
      });

      it('still rejects a vehicle_count above the max of 4', async () => {
        expect(await vehicleCountErrors(Cls, 5)).not.toEqual([]);
      });
    });
  }
});
