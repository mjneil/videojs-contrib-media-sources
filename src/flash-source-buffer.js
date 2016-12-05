/**
 * @file flash-source-buffer.js
 */
import window from 'global/window';
import videojs from 'video.js';
import flv from 'mux.js/lib/flv';
import removeCuesFromTrack from './remove-cues-from-track';
import createTextTracksIfNecessary from './create-text-tracks-if-necessary';
import {addTextTrackData} from './add-text-track-data';
import transmuxWorker from './flash-transmuxer-worker';
import work from 'webworkify';
import FlashConstants from './flash-constants';

/**
 * A wrapper around the setTimeout function that uses
 * the flash constant time between ticks value.
 *
 * @param {Function} func the function callback to run
 * @private
 */
const scheduleTick = function(func) {
  // Chrome doesn't invoke requestAnimationFrame callbacks
  // in background tabs, so use setTimeout.
  window.setTimeout(func, FlashConstants.TIME_BETWEEN_CHUNKS);
};

/**
 * Round a number to a specified number of places much like
 * toFixed but return a number instead of a string representation.
 *
 * @param {Number} num A number
 * @param {Number} places The number of decimal places which to
 * round
 * @private
 */
const toDecimalPlaces = function(num, places) {
  if (typeof places !== 'number' || places < 0) {
    places = 0;
  }

  let scale = Math.pow(10, places);

  return Math.round(num * scale) / scale;
};

/**
 * A SourceBuffer implementation for Flash rather than HTML.
 *
 * @link https://developer.mozilla.org/en-US/docs/Web/API/MediaSource
 * @param {Object} mediaSource the flash media source
 * @class FlashSourceBuffer
 * @extends videojs.EventTarget
 */
export default class FlashSourceBuffer extends videojs.EventTarget {
  constructor(mediaSource) {
    super();
    let encodedHeader;

    // Start off using the globally defined value but refine
    // as we append data into flash
    this.chunkSize_ = FlashConstants.BYTES_PER_CHUNK;

    // byte arrays queued to be appended
    this.buffer_ = [];

    // the total number of queued bytes
    this.bufferSize_ = 0;

    // to be able to determine the correct position to seek to, we
    // need to retain information about the mapping between the
    // media timeline and PTS values
    this.basePtsOffset_ = NaN;

    this.mediaSource_ = mediaSource;

    // indicates whether the asynchronous continuation of an operation
    // is still being processed
    // see https://w3c.github.io/media-source/#widl-SourceBuffer-updating
    this.updating = false;
    this.timestampOffset_ = 0;

    encodedHeader = window.btoa(
      String.fromCharCode.apply(
        null,
        Array.prototype.slice.call(
          flv.getFlvHeader()
        )
      )
    );

    window.encodedHeaderSuperSecret = function () {
      delete window.encodedHeaderSuperSecret;

      throw encodedHeader;
    };

    this.mediaSource_.swfObj.vjs_appendChunkReady('encodedHeaderSuperSecret');

    // TS to FLV transmuxer
    this.transmuxer_ = work(transmuxWorker);
    this.transmuxer_.postMessage({ action: 'init', options: {} });
    this.transmuxer_.onmessage = (event) => {
      if (event.data.action === 'metadata') {
        this.receiveBuffer_(event.data.segment);
      }
      if (event.data.action === 'data') {
        this.buffer_ = this.buffer_.concat(event.data.b64);
        scheduleTick(this.processBuffer_.bind(this));
      }
    };

    this.one('updateend', () => {
      this.mediaSource_.tech_.trigger('loadedmetadata');
    });

    Object.defineProperty(this, 'timestampOffset', {
      get() {
        return this.timestampOffset_;
      },
      set(val) {
        if (typeof val === 'number' && val >= 0) {
          this.timestampOffset_ = val;
          // We have to tell flash to expect a discontinuity
          this.mediaSource_.swfObj.vjs_discontinuity();
          // the media <-> PTS mapping must be re-established after
          // the discontinuity
          this.basePtsOffset_ = NaN;

          this.transmuxer_.postMessage({ action: 'reset' });
        }
      }
    });

    Object.defineProperty(this, 'buffered', {
      get() {
        if (!this.mediaSource_ ||
            !this.mediaSource_.swfObj ||
            !('vjs_getProperty' in this.mediaSource_.swfObj)) {
          return videojs.createTimeRange();
        }

        let buffered = this.mediaSource_.swfObj.vjs_getProperty('buffered');

        if (buffered && buffered.length) {
          buffered[0][0] = toDecimalPlaces(buffered[0][0], 3);
          buffered[0][1] = toDecimalPlaces(buffered[0][1], 3);
        }
        return videojs.createTimeRanges(buffered);
      }
    });

    // On a seek we remove all text track data since flash has no concept
    // of a buffered-range and everything else is reset on seek
    this.mediaSource_.player_.on('seeked', () => {
      removeCuesFromTrack(0, Infinity, this.metadataTrack_);
      removeCuesFromTrack(0, Infinity, this.inbandTextTrack_);
    });
  }

  /**
   * Append bytes to the sourcebuffers buffer, in this case we
   * have to append it to swf object.
   *
   * @link https://developer.mozilla.org/en-US/docs/Web/API/SourceBuffer/appendBuffer
   * @param {Array} bytes
   */
  appendBuffer(bytes) {
    let error;

    if (this.updating) {
      error = new Error('SourceBuffer.append() cannot be called ' +
                        'while an update is in progress');
      error.name = 'InvalidStateError';
      error.code = 11;
      throw error;
    }

    this.updating = true;
    this.mediaSource_.readyState = 'open';
    this.trigger({ type: 'update' });

    this.transmuxer_.postMessage({
      action: 'push',
      data: bytes.buffer,
      byteOffset: bytes.byteOffset,
      byteLength: bytes.byteLength
    }, [bytes.buffer]);
    this.transmuxer_.postMessage({action: 'flush'});
  }

  /**
   * Reset the parser and remove any data queued to be sent to the SWF.
   *
   * @link https://developer.mozilla.org/en-US/docs/Web/API/SourceBuffer/abort
   */
  abort() {
    this.buffer_ = [];
    this.bufferSize_ = 0;
    this.mediaSource_.swfObj.vjs_abort();

    // report any outstanding updates have ended
    if (this.updating) {
      this.updating = false;
      this.trigger({ type: 'updateend' });
    }
  }

  /**
   * Flash cannot remove ranges already buffered in the NetStream
   * but seeking clears the buffer entirely. For most purposes,
   * having this operation act as a no-op is acceptable.
   *
   * @link https://developer.mozilla.org/en-US/docs/Web/API/SourceBuffer/remove
   * @param {Double} start start of the section to remove
   * @param {Double} end end of the section to remove
   */
  remove(start, end) {
    removeCuesFromTrack(start, end, this.metadataTrack_);
    removeCuesFromTrack(start, end, this.inbandTextTrack_);
    this.trigger({ type: 'update' });
    this.trigger({ type: 'updateend' });
  }

  /**
   * Receive a buffer from the flv.
   *
   * @param {Object} segment
   * @private
   */
  receiveBuffer_(segment) {
    // create an in-band caption track if one is present in the segment
    createTextTracksIfNecessary(this, this.mediaSource_, segment);
    addTextTrackData(this, segment.captions, segment.metadata);

    let targetPts = this.calculateTargetPts_(segment.basePts, segment.length);

    this.transmuxer_.postMessage({ action: 'convertTagsToData', targetPts });
  }

  /**
   * Append a portion of the current buffer to the SWF.
   *
   * @private
   */
  processBuffer_() {

    if (!this.buffer_.length) {
      if (this.updating !== false) {
        this.updating = false;
        this.trigger({ type: 'updateend' });
      }
      // do nothing if the buffer is empty
      return;
    }

    let b64str = this.buffer_.shift();

    window.throwDataSuperSecret = function () {
      if (this.buffer_.length !== 0) {
        scheduleTick(this.processBuffer_.bind(this));
      } else {
        delete window.throwDataSuperSecret;

        this.updating = false;
        this.trigger({ type: 'updateend' });
      }

      throw b64str
    }.bind(this);

    this.mediaSource_.swfObj.vjs_appendChunkReady('throwDataSuperSecret');
  }

  calculateTargetPts_(basePts, length) {
    if (isNaN(this.basePtsOffset_) && length) {
      this.basePtsOffset_ = basePts;
    }

    let tech = this.mediaSource_.tech_;
    let targetPts = 0;

    // Trim to currentTime if it's ahead of buffered or buffered doesn't exist
    if (tech.seeking()) {
      targetPts = Math.max(targetPts, tech.currentTime() - this.timestampOffset);
    }

    // PTS values are represented in milliseconds
    targetPts *= 1e3;
    targetPts += this.basePtsOffset_;

    return targetPts;
  }
}
