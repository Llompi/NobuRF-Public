import { describe, expect, it } from 'vitest';
import { failOnDeviceLoss } from '../src/workbench/solve';

/** A stand-in for GPUDevice.lost that the test settles by hand. */
function fakeDevice() {
  let lose: (info: { reason: string; message: string }) => void = () => undefined;
  const lost = new Promise<{ reason: string; message: string }>((resolve) => (lose = resolve));
  return { device: { lost } as unknown as Pick<GPUDevice, 'lost'>, lose };
}

describe('GPU device loss during a workbench solve', () => {
  it('ends a solve whose readback never settles once the device is lost', async () => {
    const { device, lose } = fakeDevice();
    const stuck = failOnDeviceLoss(device, new Promise<never>(() => undefined));
    lose({ reason: 'unknown', message: 'DXGI_ERROR_DEVICE_HUNG' });
    await expect(stuck).rejects.toThrow(/GPU stopped during the solve \(DXGI_ERROR_DEVICE_HUNG\).*CPU only/);
  });

  it('passes the result through, and a later destroy() raises nothing', async () => {
    const { device, lose } = fakeDevice();
    await expect(failOnDeviceLoss(device, Promise.resolve(42))).resolves.toBe(42);
    lose({ reason: 'destroyed', message: '' }); // what engine.device.destroy() does after every solve
    await new Promise((resolve) => setTimeout(resolve, 0)); // vitest fails the run on an unhandled rejection
  });
});
