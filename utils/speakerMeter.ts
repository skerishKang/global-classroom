/**
 * 턴 단위 화자 표시 미터(#116).
 *
 * "둘 다" 모드에서 마이크(나)와 시스템 소리(상대)의 RMS를 주기적으로 샘플해
 * 지수 가중 에너지로 누적한다. 발화 턴이 끝난 시점에 dominant()로 이번 턴을
 * 지배한 소스를 판정하고, 애매하면(비슷하거나 거의 무음) 표시하지 않는다.
 *
 * 판정은 휴리스틱이다. 상대 기기 스피커로 내 목소리가 되돌아 나오면(에코)
 * 시스템 쪽이 더 크게 잡혀 오표기할 수 있다 — UI 안내에 명시한다.
 */

export type SpeakerHint = 'me' | 'counterpart';

export interface SpeakerMeterInputs {
    /** 마이크(나) RMS 샘플러(0..1). */
    me: () => number;
    /** 시스템 소리(상대) RMS 샘플러(0..1). */
    counterpart: () => number;
}

export interface SpeakerMeter {
    /** 한 샘플을 읽어 에너지를 누적한다. 250ms 간격 타이머에서 호출한다. */
    sample: () => void;
    /** 이번 턴을 지배한 화자를 판정하고 누적을 초기화한다. 애매하면 undefined. */
    dominant: () => SpeakerHint | undefined;
    /** 누적을 0으로 되돌린다. */
    reset: () => void;
}

/** 에너지 누적의 감쇠(이전 누적 유지 비율). */
const DECAY = 0.6;
/** 새 샘플의 반영 비율. */
const WEIGHT = 0.4;
/** dominant 판정 배율 — 이 배 이상 차이 나야 한쪽으로 판정한다. */
const DOMINANCE_RATIO = 1.3;
/** 양쪽 모두 이 에너지 미만이면 무음으로 보고 판정하지 않는다. */
const SILENCE_ENERGY = 1e-4;

export function createSpeakerMeter(inputs: SpeakerMeterInputs): SpeakerMeter {
    let meEnergy = 0;
    let counterpartEnergy = 0;

    return {
        sample: () => {
            const meRms = Math.max(0, inputs.me());
            const counterpartRms = Math.max(0, inputs.counterpart());
            meEnergy = meEnergy * DECAY + meRms * meRms * WEIGHT;
            counterpartEnergy = counterpartEnergy * DECAY + counterpartRms * counterpartRms * WEIGHT;
        },
        dominant: () => {
            const me = meEnergy;
            const counterpart = counterpartEnergy;
            if (me < SILENCE_ENERGY && counterpart < SILENCE_ENERGY) return undefined;
            if (counterpart > me * DOMINANCE_RATIO) return 'counterpart';
            if (me > counterpart * DOMINANCE_RATIO) return 'me';
            return undefined;
        },
        reset: () => {
            meEnergy = 0;
            counterpartEnergy = 0;
        },
    };
}
